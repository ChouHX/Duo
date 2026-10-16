"""Desktop boundary: legacy network operations remain account-local and sequential."""
import base64
import json
import logging
import re
from pathlib import Path

import requests
import interaction
import duo_killer
import alipay_qr
import checkout_options
from credentials import Vault


def empty_auth(account):
    return {'account': account, 'cookies': {key: [] for key in
            ('account_session', 'server_managed', 'with_expiry', 'expiry_unknown')}, 'trust_cookies': []}


class Service:
    def __init__(self, channel, account_dir, task_dir, account, vault=None):
        self.channel, self.root, self.task_dir, self.account = channel, account_dir, task_dir, account
        self.vault = vault or Vault()
        self.password = None
        self.remember = False
        self.authentication_requested = False
        self.authentication_failed = False
        self.action = None
        self.submitted = False
        self.auth = self.root / 'auth.json'
        self.checkout = self.root / 'checkout.json'
        duo_killer.ROOT, duo_killer.AUTH_PATH, duo_killer.LOG_PATH = self.root, self.auth, self.task_dir / 'requests.log'
        duo_killer.PAYMENT_ROOT = self.task_dir
        alipay_qr.ROOT = self.task_dir
        interaction.handler = self

    def enable_logging(self):
        from protocol import LogStream
        from platform_support import private_fd
        import os
        with os.fdopen(os.open(duo_killer.LOG_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w', encoding='utf-8') as file:
            private_fd(file.fileno())
        logger = duo_killer.log
        logger.disabled = False
        logger.propagate = False
        logger.setLevel(logging.INFO)
        formatter = logging.Formatter('%(asctime)s %(message)s', '%H:%M:%S')
        for handler in (logging.FileHandler(duo_killer.LOG_PATH, encoding='utf-8'), logging.StreamHandler(LogStream(self.channel))):
            handler.setFormatter(formatter)
            logger.addHandler(handler)

    def ensure_auth_file(self):
        if self.auth.exists():
            data = json.loads(self.auth.read_text(encoding='utf-8'))
            if data.get('account', '').casefold() != self.account.casefold():
                raise ValueError('本地会话的账号与所选账号不同，请重新导入正确的会话。')
            if 'password' in data:
                data.pop('password')
                duo_killer.write_private_json(self.auth, data)
            return False
        duo_killer.write_private_json(self.auth, empty_auth(self.account))
        return True

    def credentials(self, path):
        self.authentication_requested = True
        if not self.password:
            try:
                self.password = self.vault.get(self.channel.account_id)
            except Exception:
                self.stage('系统凭据保险库不可用，请输入本次登录密码')
        if not self.password:
            value = self.channel.prompt('password', '输入 Apple 账号密码', account=self.account)
            if not isinstance(value, dict) or not isinstance(value.get('password'), str) or not value['password']:
                raise ValueError('请输入密码。')
            self.password = value['password']
            self.remember = value.get('remember') is True
        return self.account, self.password

    def text(self, label, default=''):
        kind = 'code' if '验证码' in label else 'text'
        label = label.replace('👉 ', '')
        fields = {}
        if kind == 'code':
            # Expose only the transitions supported by this legacy prompt.
            for hint, value, title in (
                ('（输入 s 改用短信）', 's', '改用短信验证码'),
                ('（输入 d 改用设备）', 'd', '改用设备验证码'),
            ):
                if hint in label:
                    label = label.replace(hint, '')
                    fields['actions'] = [{'value': value, 'label': title}]
        value = self.channel.prompt(kind, label, default=default, **fields)
        if not isinstance(value, str) or len(value) > 4096:
            raise ValueError('输入格式不正确。')
        return value

    def choose(self, label, options, default=None):
        return self.channel.prompt('select', label, options=[{'value': k, 'label': v} for k, v in options], default=default)

    def confirm(self, details):
        return self.channel.prompt('confirm', '确认商品与金额，创建订单', details=details, account=self.account)

    def stage(self, stage, **fields):
        self.authentication_failed = self.authentication_failed or fields.get('authentication_failed', False)
        if 'browser_pid' in fields:
            self.channel.emit('stage', message=stage, **fields)
            self.channel.checkpoint()
            return
        self.channel.checkpoint()
        self.submitted = self.submitted or fields.get('order_submitted', False)
        self.channel.emit('stage', message=stage, **fields)

    def persist_password(self):
        if self.remember and self.password:
            try:
                self.vault.save(self.channel.account_id, self.password)
            except Exception:
                self.stage('操作成功，但系统未保存密码；下次登录需重新输入')

    def cleanup_credentials(self, error=None):
        if self.should_remove_account(error):
            try:
                self.vault.delete(self.channel.account_id)
            finally:
                self.auth.unlink(missing_ok=True)
                self.password = None
            return
        if error and '-20101' in str(error):
            try:
                self.vault.delete(self.channel.account_id)
            except Exception:
                pass
        if self.auth.exists():
            data = json.loads(self.auth.read_text(encoding='utf-8'))
            data.pop('password', None)
            # Legacy failure cleanup may remove the account too. Keep the registry identity.
            data['account'] = self.account
            duo_killer.write_private_json(self.auth, data)
        self.password = None

    @staticmethod
    def transient_status(error):
        """提取错误里的官网瞬时故障状态码（5xx / 429），没有则返回 None。

        错误可能本身就是 LoginError，也可能是包装它的 ValueError / HTTPError，
        所以把常见的几种携带状态码的位置都看一遍。
        """
        from apple_login import is_transient_status
        cause = getattr(error, '__cause__', None)
        candidates = (getattr(error, 'status', None),
                      getattr(getattr(error, 'response', None), 'status_code', None),
                      getattr(cause, 'status', None),
                      getattr(getattr(cause, 'response', None), 'status_code', None))
        return next((s for s in candidates if s is not None and is_transient_status(s)), None)

    def should_remove_account(self, error):
        # 官网 5xx / 429 是暂时性故障（541 是反爬拦截，同样不代表账号失效），
        # 这类失败不能移除账号：用户稍后重试就能继续用同一份本地会话。
        if (isinstance(error, requests.RequestException)
                or self.transient_status(error) is not None):
            return False
        return (self.action != 'enroll' and self.authentication_failed
                and isinstance(error, ValueError) and not self.submitted)

    def check_account(self, *, enrolling=False):
        if enrolling:
            self.stage('正在登录，完成验证后才会添加账号')
            duo_killer.login()
        with requests.Session() as session:
            duo_killer.load_auth(session, json.loads(self.auth.read_text(encoding='utf-8')))
            save_session = True
            retried = False
            try:
                self.stage('正在查询当前登录人')
                try:
                    # Keep -me's account-page reauthentication and current SSI/session.
                    result = duo_killer.account_info(session)
                except (ValueError, requests.RequestException) as error:
                    if self.transient_status(error) is not None:
                        # 官网暂时故障（5xx / 429）：重登只会撞上同一个错误，
                        # 直接让用户稍后重试，不要把账号推去做一次完整登录。
                        raise
                    # Wrong passwords, rejected OTPs and a failed reauthentication must
                    # reach the user instead of starting another login loop.
                    if enrolling or self.authentication_requested:
                        raise
                    result = None
                if (not result or result.get('success') is not True
                        or result.get('logged_in') is not True or not result.get('apple_id')):
                    if enrolling or self.authentication_requested:
                        raise ValueError('登录后仍无法确认当前账号，请检查登录结果后重试。')
                    self.stage('未确认当前登录人，执行一次完整登录')
                    save_session = False
                    retried = True
                    duo_killer.login()
                    session.cookies.clear()
                    duo_killer.load_auth(session, json.loads(self.auth.read_text(encoding='utf-8')))
                    save_session = True
                    result = duo_killer.account_info(session)
                if (result.get('success') is not True or result.get('logged_in') is not True
                        or not result.get('apple_id')):
                    raise ValueError('无法确认当前登录人，未启用此账号。')
                return result
            except ValueError:
                if not enrolling and (retried or self.authentication_requested):
                    self.authentication_failed = True
                raise
            finally:
                if save_session:
                    duo_killer.save_auth(session)

    def run(self, action, params):
        self.action = action
        self.channel.checkpoint()
        if action == 'address_read':
            config = checkout_options.read_config(self.checkout)
            own = checkout_options.read_config(self.checkout, defaults=False)
            inherited = bool(checkout_options.value(config, 'address.street')
                             and not checkout_options.value(own, 'address.street'))
            return {'success': True, 'config': config, 'inherited': inherited}
        if action == 'address_save':
            config = checkout_options.read_config(self.checkout)
            details = validate_address(params)
            config.update(details)
            # 界面已移除“全自动下单”开关：下单始终全自动，这里顺带把历史配置里的 false 纠正过来。
            config['auto_checkout'] = True
            if 'applecare' in params:
                config['applecare'] = bool(params['applecare'])
            if 'method' in params:
                config['delivery_method'] = method_value(params.get('method'))
            checkout_options.save_config(self.checkout, config)
            address = ' '.join(details['delivery'].values()) + ' ' + details['address']['street']
            message = f'快捷地址已保存：{address}。下单时直接使用，全程全自动。'
            if config.get('delivery_method') == 'pickup':
                message += '送货方式：门店自提。'
            elif config.get('delivery_method') == 'delivery':
                message += '送货方式：快递配送。'
            if config.get('applecare'):
                message += '已开启 AppleCare+：下单时按官网内联推荐一并加入。'
            return {'success': True, 'config': config, 'message': message}
        if action == 'preset_apply':
            config = checkout_options.apply_preset(self.checkout)
            parts = []
            if checkout_options.value(config, 'address.street'):
                parts.append('地址')
            if config.get('delivery_method') == 'pickup':
                parts.append('送货方式（门店自提）')
            elif config.get('delivery_method') == 'delivery':
                parts.append('送货方式（快递配送）')
            if checkout_options.value(config, 'store.id'):
                parts.append('自提门店')
            if config.get('applecare'):
                parts.append('AppleCare+')
            message = '已按通用预设填入并保存：' + '、'.join(parts) + '。' if parts else '已按通用预设填入并保存。'
            return {'success': True, 'config': config, 'message': message}
        if action == 'store_save':
            config = checkout_options.read_config(self.checkout)
            message = ''
            # 送货方式：快递配送（delivery）或门店自提（pickup）；下单时直接按它走。
            if 'method' in params:
                method = method_value(params.get('method'))
                config['delivery_method'] = method
                message = ('已选择门店自提：下单时直接自提。' if method == 'pickup'
                           else '已选择快递配送：下单时直接送货。')
            # 全自动下单不再可关（下单方式就是全自动），只保留历史配置的纠正。
            config['auto_checkout'] = True
            if 'applecare' in params:
                config['applecare'] = bool(params['applecare'])
                message += '已开启 AppleCare+。' if config['applecare'] else '已关闭 AppleCare+。'
            if 'store' in params:
                store = params.get('store')
                if store:
                    if not isinstance(store, dict):
                        raise ValueError('请选择取货地区（省 / 市 / 区）。')
                    region = [str(store.get(key) or '') for key in ('state', 'city', 'district')]
                    if not store.get('id') and not all(region):
                        raise ValueError('请选择取货地区（省 / 市 / 区）。')
                    config['store'] = {'id': str(store.get('id') or ''), 'name': str(store.get('name') or ''),
                                       'state': region[0], 'city': region[1], 'district': region[2]}
                    where = ' '.join(part for part in region if part)
                    message += (f"已预设取货门店：{config['store']['name'] or config['store']['id']}。"
                                '下单时优先自提并自动选择该门店。' if config['store']['id'] else
                                f"已预设取货地区：{where}。下单时自动选择最近且有货的门店。")
                else:
                    config.pop('store', None)
                    message += '已清除取货门店预设，下单时可重新选择。'
            checkout_options.save_config(self.checkout, config)
            return {'success': True, 'config': config, 'message': message}
        if action == 'import_auth':
            data = validate_import(params.get('data'), self.account)
            duo_killer.write_private_json(self.auth, data)
            return {'success': True, 'message': '会话已导入，点击检查登录以确认有效性。'}
        if action == 'forget_password':
            self.vault.delete(self.channel.account_id)
            return {'success': True, 'message': '已删除系统保存的密码。'}
        if action == 'catalog':
            from shop_catalog import query_store, query_duo
            return query_duo(duo_killer.request_get) if params.get('mode') == 'duo' else query_store(duo_killer.request_get, phone_only=params.get('mode') == 'phone')
        self.ensure_auth_file()
        if action in ('enroll', 'me'):
            result = self.check_account(enrolling=action == 'enroll')
        elif action == 'login':
            result = duo_killer.login(sms=params.get('sms') is True)
        elif action == 'purchase':
            result = duo_killer.purchase_items(purchase_items(params))
        elif action == 'timed_purchase':
            at = params.get('at')
            if isinstance(at, bool) or not isinstance(at, (int, float)) or not 1_500_000_000 <= at <= 4_000_000_000:
                raise ValueError('抢购时间无效，请重新选择。')
            warmup = params.get('warmup', 300)
            if type(warmup) is not int or not 0 <= warmup <= 3600:
                raise ValueError('提前预热时间须为 0–3600 秒。')
            result = duo_killer.timed_purchase(purchase_items(params), at=float(at), warmup=warmup,
                                               probe=self.channel.checkpoint)
        elif action == 'add':
            result = duo_killer.add_items(purchase_items(params))
        elif action == 'checkout':
            result = duo_killer.pay_bag()
        elif action == 'qr':
            source_id = str(params.get('source_task', ''))
            import uuid
            if str(uuid.UUID(source_id)) != source_id:
                raise ValueError('付款任务编号无效。')
            data = json.loads((self.root / 'tasks' / source_id / 'payment.json').read_text(encoding='utf-8'))
            duo_killer.payment_qr(data)
            duo_killer.write_private_json(self.task_dir / 'payment.json', data)
            result = data
        elif action in ('orders', 'bag', 'region', 'region_options', 'stores'):
            if action == 'region':
                detail = checkout_options.account_region(self.auth)
                region = detail.get('region') or {}
                message = ('已读取官网默认收货地址：%s。仍需点击“保存地址预设”保存在本机。'
                           % ' '.join(region.values())) if region else \
                          '官网账号没有默认收货地址，请用下方省 / 市 / 区选择后保存。'
                return {'success': True, **detail, 'message': message}
            if action == 'region_options':
                level = str(params.get('level', ''))
                state = params.get('state') or None
                city = params.get('city') or None
                options = checkout_options.account_region_options(self.auth, level, state, city)
                return {'success': True, 'level': level, 'state': state or '',
                        'city': city or '', 'options': options}
            if action == 'stores':
                config = checkout_options.read_config(self.checkout)
                from duo_killer import normalize_sku, DEFAULT_PURCHASE_SKU
                # 优先用界面传来的 SKU（就是账号下单用的商品），旧配置字段只作兜底。
                raw = str(params.get('sku')
                          or checkout_options.value(config, 'purchase.sku') or '').strip()
                try:
                    sku = normalize_sku(raw or DEFAULT_PURCHASE_SKU)
                except ValueError:
                    sku = ''
                stores = checkout_options.store_search(
                    self.auth, params.get('state', ''), params.get('city', ''),
                    params.get('district', ''), params.get('search', ''), sku)
                return {'success': True, 'stores': stores,
                        'state': params.get('state', ''), 'city': params.get('city', ''),
                        'district': params.get('district', ''), 'sku': sku}
            with requests.Session() as session:
                duo_killer.authenticate(session, strong=True)
                try:
                    if action == 'orders':
                        result = duo_killer.order_list(session)
                    else:
                        flow = duo_killer.Checkout(session)
                        flow.page(duo_killer.BASE_URL + '/shop/bag', '读取购物袋')
                        # 只读展示：某个商品或合计没有可识别的金额时不要整单失败。
                        total = duo_killer.order_price(duo_killer.field(flow.model, 'shoppingCart.summary.d.total'),
                                                       context='购物袋', required=False)
                        result = {'success': True, 'items': [
                            {'name': duo_killer.order_text(duo_killer.field(item, 'd.name') or duo_killer.field(item, 'd.productName')),
                             'sku': duo_killer.field(item, 'd.sku'), 'quantity': duo_killer.field(item, 'itemQuantity.d.quantity'),
                             'subtotal': duo_killer.order_price(duo_killer.field(item, 'd.totalPrice'),
                                                                context='购物袋', required=False)}
                            for item in duo_killer.model_item_nodes(duo_killer.field(flow.model, 'shoppingCart.items', {}))],
                            'total': total}
                        if not total:
                            result['message'] = ('官网未返回可识别的购物袋合计金额：购物袋里可能有没有价格的商品或暂时无法购买的商品，'
                                                 '请到官网购物袋确认后再下单。')
                finally:
                    duo_killer.save_auth(session)
        else:
            raise ValueError('不支持的操作。')
        self.persist_password()
        if action in ('enroll', 'login', 'me') and result.get('logged_in') is True:
            from apple_login import stored_device_trust
            result['device_trust_saved'] = bool(stored_device_trust(
                json.loads(self.auth.read_text(encoding='utf-8')), self.account))
        if result.get('qr_image'):
            path = Path(result['qr_image']).resolve()
            if path.parent != self.task_dir.resolve() or path.stat().st_size > 2_000_000:
                raise ValueError('二维码文件不在当前任务目录。')
            result['qr_data'] = 'data:image/png;base64,' + base64.b64encode(path.read_bytes()).decode()
        return result


def quantity(params):
    value = params.get('quantity', 1)
    if type(value) is not int or not 1 <= value <= 999:
        raise ValueError('数量须为 1–999 的整数；实际限购数量以官网为准。')
    return value


DELIVERY_METHODS = ('delivery', 'pickup')


def method_value(value):
    """送货方式：delivery=快递配送，pickup=门店自提。"""
    method = str(value or '').strip()
    if method not in DELIVERY_METHODS:
        raise ValueError('请选择送货方式：快递配送或门店自提。')
    return method


def purchase_items(params):
    """下单/加购的商品：新格式 items=[{sku, quantity}]，兼容单个 sku + quantity。

    这里只负责校验并返回原始字典列表；真正的规整（合并同款）由
    duo_killer.normalize_items 在加购/下单时做一次，不要再把规整后的
    (sku, quantity) 元组传下去，否则会被当成非法条目。
    """
    raw = params.get('items')
    if raw is None:
        raw = [{'sku': params.get('sku') or duo_killer.DEFAULT_PURCHASE_SKU,
                'quantity': quantity(params)}]
    elif not isinstance(raw, list):
        raise ValueError('商品列表格式不正确。')
    duo_killer.normalize_items(raw)  # 只做校验，抛出清晰的错误信息。
    return raw


def validate_address(data):
    expected = {'contact': ['lastName', 'firstName', 'emailAddress', 'fullDaytimePhone'],
                'delivery': ['state', 'city', 'district'], 'address': ['street']}
    result = {}
    for group, keys in expected.items():
        values = data.get(group, {})
        result[group] = {}
        for key in keys:
            value = values.get(key)
            if not isinstance(value, str) or not value.strip() or len(value) > 200:
                raise ValueError('请完整填写联系人、省市区和详细地址。')
            result[group][key] = value.strip()
    if not re.fullmatch(r'\d{11,12}', result['contact']['fullDaytimePhone']):
        raise ValueError('请输入正确的手机号码。')
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', result['contact']['emailAddress']):
        raise ValueError('请输入正确的通知邮箱。')
    return result


def validate_import(data, account):
    if not isinstance(data, dict) or str(data.get('account', '')).casefold() != account.casefold():
        raise ValueError('导入文件的 account 必须与当前账号一致。')
    clean = empty_auth(account)
    groups = data.get('cookies', {})
    for group in clean['cookies']:
        rows = groups.get(group, [])
        if not isinstance(rows, list):
            raise ValueError('Cookie 分组格式不正确。')
        for cookie in rows:
            if not isinstance(cookie, dict) or not all(isinstance(cookie.get(k), str) for k in ('name', 'value', 'domain')):
                raise ValueError('Cookie 格式不正确。')
            domain = cookie['domain'].lstrip('.')
            if domain == 'apple.com.cn' or domain.endswith('.apple.com.cn'):
                clean['cookies'][group].append(cookie)
    clean['headers'] = {k: v for k, v in data.get('headers', {}).items()
                        if k.lower() in ('user-agent', 'accept-language') and isinstance(v, str)}
    from apple_login import stored_device_trust, TRUST_COOKIE_NAME
    clean['trust_account'] = account
    clean['trust_cookies'] = stored_device_trust(data, account)
    # Keep trust in one authoritative list, including when the source revoked it.
    for group, rows in clean['cookies'].items():
        clean['cookies'][group] = [c for c in rows if not TRUST_COOKIE_NAME.fullmatch(c['name'])]
    return clean
