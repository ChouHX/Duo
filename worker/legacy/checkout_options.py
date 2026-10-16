"""根据结账页面实时模型选择配送、自提与收货地址。"""
import hashlib
import json
import os
import re
import sys
import tempfile
from urllib.parse import urlencode, urlsplit

import requests
import interaction


def value(node, path, default=None):
    for key in path.split('.'):
        if not isinstance(node, dict) or key not in node:
            return default
        node = node[key]
    return node


def read_config(path, defaults=True):
    """读取结账配置。

    账号自己的 checkout.json 里没填的字段，回退到通用预设
    （同一数据目录下的 settings/checkout.json），这样“通用预设”对已有账号同样生效，
    而不是只在添加账号时复制一次。
    """
    config = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if not isinstance(config, dict):
        raise ValueError('checkout.json 必须是 JSON 对象。')
    if not defaults:
        return config
    base = default_config_path(path)
    if base is None:
        return config
    inherited = read_config(base, defaults=False)
    return merge_defaults(inherited, config) if inherited else config


def default_config_path(path):
    """账号配置的兜底来源：<数据目录>/settings/checkout.json（通用预设）。

    仅对 <数据目录>/accounts/<账号ID>/checkout.json 这种布局生效；通用预设自身不再回退。
    """
    if path.parent.name == 'settings' or path.parent.parent.name != 'accounts':
        return None
    candidate = path.parent.parent.parent / 'settings' / 'checkout.json'
    return candidate if candidate.is_file() else None


def merge_defaults(defaults, config):
    """账号自己填过的字段优先，其余从通用预设继承；嵌套字段逐项合并。"""
    merged = dict(defaults)
    for key, val in config.items():
        if isinstance(val, dict) and isinstance(merged.get(key), dict):
            merged[key] = {**merged[key], **val}
        else:
            merged[key] = val
    return merged


def auto_checkout(config):
    """全自动下单：缺省启用，只有明确写入 False 才关闭。"""
    return config.get('auto_checkout') is not False


def apply_preset(path):
    """把“通用预设”整份复制到账号自己的 checkout.json（账号已填的同名字段会被覆盖）。"""
    general = default_config_path(path)
    if general is None:
        raise ValueError('通用预设不可用。')
    source = read_config(general, defaults=False)
    if not source:
        raise ValueError('通用预设还是空的，请先在“通用预设”里填写地址或送货方式。')
    target = read_config(path, defaults=False)
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            target[key] = {**target[key], **value}
        else:
            target[key] = value
    # 下单始终全自动，这里保持一致。
    target['auto_checkout'] = True
    save_config(path, target)
    return target


def preset_complete(config):
    """本地快捷地址是否足够用于“使用本地快捷地址”结账。"""
    return bool(str(value(config, 'address.street') or '').strip()
                and isinstance(config.get('delivery'), dict) and config['delivery'])


def save_config(path, config):
    fd, name = tempfile.mkstemp(prefix='.checkout-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as file:
            json.dump(config, file, ensure_ascii=False, indent=2)
            file.write('\n')
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def ask(label, default='', pattern=None):
    if interaction.handler is not None:
        while True:
            answer = interaction.handler.text(label, default=default).strip()
            if answer and (pattern is None or re.fullmatch(pattern, answer)):
                return answer
            interaction.report_stage('输入为空或格式不正确，请重新输入')
            default = ''
    while True:
        if default and sys.stdin.isatty() and sys.stdout.isatty():
            from prompt_toolkit import prompt
            answer = prompt('👉 ' + label + '：', default=default).strip()
        else:
            answer = input(f'👉 {label}' + (f' [{default}]' if default else '') + '：').strip() or default
        if answer and (pattern is None or re.fullmatch(pattern, answer)):
            return answer
        default = ''  # 用户清空预填内容后，不再偷偷恢复旧默认值。
        print('输入为空或格式不正确，请重新输入。')


def choose(label, options, default=None):
    if not options:
        raise ValueError(label + '：没有可选项，已停止。')
    if interaction.handler is not None:
        selected = interaction.handler.choose(label, options, default)
        if selected not in [key for key, _ in options]:
            raise ValueError('所选选项已失效，请重新开始当前操作。')
        return selected
    if sys.stdin.isatty() and sys.stdout.isatty():
        from prompt_toolkit.key_binding import KeyBindings
        from prompt_toolkit.shortcuts import choice

        keys = KeyBindings()

        @keys.add('c-d')
        def cancel(event):
            event.app.exit(exception=EOFError())

        return choice('👉 ' + label + '（↑↓ 选择，回车确认，Ctrl+C/D 取消）',
                      options=options, default=default, key_bindings=keys)
    print('\n' + label)
    for index, (key, title) in enumerate(options, 1):
        print(f'{index}. {title}')
    default_index = next((i for i, (key, _) in enumerate(options, 1) if key == default), None)
    while True:
        answer = input('👉 请选择序号' + (f'（回车选 {default_index}）' if default_index else '') + '：').strip()
        if not answer and default_index:
            return options[default_index - 1][0]
        if answer.isdecimal() and 1 <= int(answer) <= len(options):
            return options[int(answer) - 1][0]
        print('请输入有效序号。')


def contact(config):
    saved = config.get('contact', {})
    result = {}
    for key, label, pattern in (
        ('lastName', '收件/取货人姓氏', None), ('firstName', '名字', None),
        ('emailAddress', '通知邮箱', r'[^\s@]+@[^\s@]+\.[^\s@]+'),
        ('fullDaytimePhone', '手机号码', r'\d{11,12}'),
    ):
        old = saved.get(key, '')
        result[key] = old if old and (pattern is None or re.fullmatch(pattern, old)) else ask(label, pattern=pattern)
    return result


LOCATION_URL = 'https://www.apple.com.cn/shop/address/location/update'
REGION_KEYS = ('state', 'city', 'district')


def region_from_address(address):
    """从官网地区响应中提取省 / 市 / 区，缺项不臆造。"""
    if not isinstance(address, dict):
        return {}
    return {key: address[key].strip() for key in REGION_KEYS
            if isinstance(address.get(key), str) and address[key].strip()}


def current_region_detail(auth_path):
    """读取官网会话地区，返回 (地区, 说明)。

    地区为空时用说明区分原因（未登录 / 网络失败 / 会话没有保存地区），
    让界面能提示用户，而不是静默成功。不提交定位同意，不修改登录配置。
    """
    from duo_killer import load_auth, log
    from apple_login import is_transient_status
    session = requests.Session()
    try:
        if auth_path.exists():
            load_auth(session, json.loads(auth_path.read_text(encoding='utf-8')))
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        log.warning('读取官网地区失败：本地会话不可用（%s）。', type(error).__name__)
        return {}, '本地会话文件不可用，请先完成该账号登录或重新导入会话。'
    try:
        response = session.get(
            LOCATION_URL, timeout=(3, 8), allow_redirects=False,
            headers={'Accept': 'application/json', 'Referer': 'https://www.apple.com.cn/',
                     'X-Requested-With': 'XMLHttpRequest'})
        if response.is_redirect:
            log.info('读取官网地区：官网要求登录（HTTP %s）。', response.status_code)
            return {}, '官网会话已失效，请先完成该账号登录后再读取地区。'
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as error:
        log.warning('读取官网地区失败：%s。', type(error).__name__)
        status = getattr(getattr(error, 'response', None), 'status_code', None)
        if status is not None and is_transient_status(status):
            # 官网 5xx / 429 与用户的网络、代理无关，别让用户白折腾代理设置。
            return {}, f'Apple 官网暂时不可用（HTTP {status}），请稍后重试。'
        return {}, '网络请求失败，请检查网络或系统代理。'
    except (ValueError, KeyError, TypeError) as error:
        log.warning('读取官网地区失败：官网响应无法解析（%s）。', type(error).__name__)
        return {}, '官网未返回可解析的地区数据，请稍后重试。'
    finally:
        session.close()
    if str(value(data, 'head.status')) != '200':
        log.warning('读取官网地区失败：官网业务状态 %s。', value(data, 'head.status'))
        return {}, '官网未确认地区请求，请稍后重试。'
    content = value(data, 'body.content', {})
    region = region_from_address(content.get('address'))
    if not region:
        log.info('读取官网地区：会话没有保存的收货地区。')
        return {}, '官网会话没有保存的收货地区，请手动填写省市区后再保存。'
    # 官网返回的默认地区（按网络定位）也照常采用，用户可修改后再保存。
    note = '（官网默认地区）' if content.get('userEnteredLocation') is not True else ''
    return region, '已读取官网地区%s：%s。' % (note, ' '.join(region.values()))


def current_region(auth_path):
    """读取官网会话地区，不提交定位同意，不修改登录配置。"""
    return current_region_detail(auth_path)[0]


# ------------------------------------------------------------------ 账号地址 --
# 官网没有单独的「省市县」字典接口：必须打开账号首页的「编辑地址」，
# 那里才下发 stateOptions / cityOptions / districtOptions 以及联动动作。
ACCOUNT_HOME = 'https://secure.www.apple.com.cn/shop/account/home'
EDIT_SELECTOR = ('home.customerAccount.shippingInfo.shippingAddress'
                 '.editShippingAddress.editAddress.stateCitySelectorForCheckout')
REGION_OPTIONS = {'state': 'stateOptions', 'city': 'cityOptions', 'district': 'districtOptions'}
# 账号首页把省份存成 ISO 3166-2:CN 代码，编辑页用的是中文名。
PROVINCE_NAMES = {
    'BJ': '北京', 'TJ': '天津', 'HE': '河北', 'SX': '山西', 'NM': '内蒙古',
    'LN': '辽宁', 'JL': '吉林', 'HL': '黑龙江', 'SH': '上海', 'JS': '江苏',
    'ZJ': '浙江', 'AH': '安徽', 'FJ': '福建', 'JX': '江西', 'SD': '山东',
    'HA': '河南', 'HB': '湖北', 'HN': '湖南', 'GD': '广东', 'GX': '广西壮族自治区',
    'HI': '海南', 'CQ': '重庆', 'SC': '四川', 'GZ': '贵州', 'YN': '云南',
    'XZ': '西藏自治区', 'SN': '陕西', 'GS': '甘肃', 'QH': '青海', 'NX': '宁夏回族自治区',
    'XJ': '新疆维吾尔自治区',
}


def _account_flow(auth_path):
    """建立已登录会话并打开账号首页的编辑地址选择器。

    官网会话被挑战时，复用「检查登录」的重新认证链路自动恢复，
    然后再读账户页。返回 (session, flow)；调用方负责 session.close()。
    """
    from duo_killer import Checkout, load_auth, account_info, save_auth, log
    session = requests.Session()
    try:
        load_auth(session, json.loads(auth_path.read_text(encoding='utf-8')))
        flow = Checkout(session)
        flow.page(ACCOUNT_HOME, '读取账户')
        if 'signIn' in flow.model or urlsplit(flow.url).path.startswith('/shop/signIn'):
            log.info('读取官网地区：官网要求重新认证，改用保存的凭据登录。')
            account_info(session)
            save_auth(session)
            flow = Checkout(session)
            flow.page(ACCOUNT_HOME, '读取账户')
            if 'signIn' in flow.model or urlsplit(flow.url).path.startswith('/shop/signIn'):
                raise ValueError('官网会话已失效，请先完成该账号登录后再读取官网地区。')
        flow.action('home.customerAccount.shippingInfo.shippingAddress', 'editAddress')
        flow.require(EDIT_SELECTOR)
        return session, flow
    except Exception:
        session.close()
        raise


def _region_payload(flow, path, **wanted):
    node = value(flow.model, path + '.d', {})
    payload = {path + '.' + key: node.get(key, '') for key in
               ('state', 'city', 'district', 'provinceCityDistrict')}
    payload.update({path + '.' + key: val for key, val in wanted.items()})
    payload[path + '.countryCode'] = 'CN'
    return payload


def account_region(auth_path):
    """读取账号首页的默认收货地址，并返回省市区选项。

    返回 {'region': {...}, 'contact': {...}, 'address': {...}, 'states': [...],
        'saved': 是否真的取到默认地址}。
    """
    session, flow = _account_flow(auth_path)
    try:
        shipping = value(flow.model,
                         'home.customerAccount.shippingInfo.shippingAddress.d', {})
        shipping = shipping if isinstance(shipping, dict) else {}
        states = value(flow.model, EDIT_SELECTOR + '.d.stateOptions', []) or []
    finally:
        session.close()
    values = {option.get('value') for option in states if isinstance(option, dict)}
    state = shipping.get('state')
    state = PROVINCE_NAMES.get(str(state).upper(), '') if isinstance(state, str) else ''
    if not state and shipping.get('state') in values:
        state = shipping['state']
    city = shipping.get('city')
    city = city.rstrip(', ').strip() if isinstance(city, str) else ''
    region = {key: val for key, val in (('state', state), ('city', city)) if val}
    contact = {key: shipping[key] for key in ('lastName', 'firstName', 'fullDaytimePhone')
               if isinstance(shipping.get(key), str) and shipping[key].strip()}
    address = {key: shipping[key] for key in ('street', 'street2')
               if isinstance(shipping.get(key), str) and shipping[key].strip()}
    return {'region': region, 'contact': contact, 'address': address,
            'states': states, 'saved': bool(region or contact or address)}


REGION_LOOKUP = 'https://www.apple.com.cn/shop/address-lookup'


def lookup_regions(state='', city=''):
    """官网地区级联：无参取省，带 state 取市，带 state+city 取区。

    这个接口不需要登录会话，通用预设也能用。
    """
    params = {}
    if state:
        params['state'] = state
    if city:
        params['city'] = city
    level = 'district' if (state and city) else ('city' if state else 'state')
    response = requests.get(REGION_LOOKUP, params=params,
                            headers={'accept': '*/*', 'accept-language': 'zh-CN,zh;q=0.9'},
                            timeout=20)
    if response.status_code != 200:
        raise ValueError(f'读取官网地区失败：HTTP {response.status_code}。')
    try:
        data = response.json()
    except ValueError:
        raise ValueError('读取官网地区失败：返回了非 JSON 内容。') from None
    rows = value(data, 'body.' + level + '.data', []) or []
    return [{'value': str(row['value']), 'label': str(row.get('label') or row['value'])}
            for row in rows if isinstance(row, dict) and row.get('value')]


def account_region_options(auth_path, level, state=None, city=None):
    """按层级返回省 / 市 / 区选项；city 需要 state，district 需要 state 和 city。"""
    if level not in REGION_OPTIONS:
        raise ValueError('不支持的地区层级。')
    if level in ('city', 'district') and not state:
        raise ValueError('请先选择省 / 直辖市。')
    if level == 'district' and not city:
        raise ValueError('请先选择城市。')
    try:
        return lookup_regions(state or '', city if level == 'district' else '')
    except (ValueError, requests.RequestException):
        pass  # 官网接口不可用时回退到账号页面的地区选择器。
    session, flow = _account_flow(auth_path)
    try:
        if level in ('city', 'district'):
            flow.action(EDIT_SELECTOR, 'Selectstate',
                        _region_payload(flow, EDIT_SELECTOR, state=state))
        if level == 'district':
            flow.action(EDIT_SELECTOR, 'Selectcity',
                        _region_payload(flow, EDIT_SELECTOR, state=state, city=city))
        return value(flow.model, EDIT_SELECTOR + '.d.' + REGION_OPTIONS[level], []) or []
    finally:
        session.close()


# -------------------------------------------------------------- 零售店查询 --
def _store_summary(store):
    lines = value(store, 'availability.lineItemAvailability', []) or []
    availability = [{'name': line.get('partName'), 'quote': line.get('availabilityQuote')}
                    for line in lines if isinstance(line, dict)]
    return {
        'id': store.get('storeId'), 'name': store.get('storeName'),
        'disabled': store.get('storeDisabled') is True,
        'city': store.get('city') or store.get('storeCity') or '',
        'address': store.get('address') or store.get('storeAddress') or '',
        'distance': store.get('distance'),
        'availability': availability,
    }


def store_search_requests(auth_path, state='', city='', district='', search=''):
    """在购物袋页的「门店定位器」里按省/市/区查询可自提的零售店。

    需要购物袋里至少有一件商品（官网门店定位器挂在商品上）。返回门店摘要列表。
    """
    from duo_killer import Checkout, BASE_URL, load_auth, account_info, save_auth, log
    session = requests.Session()
    try:
        load_auth(session, json.loads(auth_path.read_text(encoding='utf-8')))
        flow = Checkout(session)
        flow.page(BASE_URL + '/shop/bag', '读取购物袋')
        if 'signIn' in flow.model or urlsplit(flow.url).path.startswith('/shop/signIn'):
            log.info('查询门店：官网要求重新认证，改用保存的凭据登录。')
            account_info(session)
            save_auth(session)
            flow = Checkout(session)
            flow.page(BASE_URL + '/shop/bag', '读取购物袋')
        items = [key for key in value(flow.model, 'shoppingCart.items', {}) if key.startswith('item-')]
        if not items:
            raise ValueError('购物袋为空，请先加入一件商品后再查询门店。')
        base = 'shoppingCart.items.' + items[0] + '.delivery'
        # 先取反爬令牌 as_atb，否则 /shop/bagx 的 POST 会被官网以 541 拒绝。
        from duo_killer import request_get
        request_get(session, '门店反爬令牌', BASE_URL + '/shop/beacon/atb')
        flow.action(base, 'storeLocatorView')
        locator = base + '.storeLocator'
        tabs = locator + '.address.provinceCityDistrictTabs'
        if state:
            flow.action(tabs, 'Selectstate', _region_payload(flow, tabs, state=state))
        if city:
            flow.action(tabs, 'Selectcity',
                        _region_payload(flow, tabs, state=state, city=city))
        payload = {locator + '.showAllStores': 'false', locator + '.selectStore': '',
                   locator + '.searchInput': search or district or city or state}
        payload.update(_region_payload(flow, tabs, state=state, city=city, district=district))
        flow.action(locator, 'search', payload)
        stores = value(flow.model, locator + '.searchResults.d.retailStores', []) or []
        return [_store_summary(store) for store in stores if isinstance(store, dict)]
    finally:
        session.close()


def store_search_messages(auth_path, state, city, district, sku):
    """按「省 → 市 → 区」查询可自提门店（官网 fulfillment-messages）。

    官网这个接口只认真实浏览器：requests 即使带上有效 Cookie 也会被 541 拦截，
    所以在专用 Chrome 配置里先取 as_atb 反爬令牌，再用页面自身的 fetch 请求。
    不需要登录会话。
    """
    from apple_login import open_browser_page, BrowserContextError
    location = ' '.join(part for part in (state, city, district) if part)
    if not location:
        raise ValueError('请先选择省 / 市 / 区。')
    if not sku:
        raise ValueError('请先在“购买预设”里选择商品 SKU，门店可用性按商品查询。')
    query = urlencode({'fae': 'true', 'pl': 'true', 'mts.0': 'regular',
                       'parts.0': sku, 'location': location})
    url = 'https://www.apple.com.cn/shop/fulfillment-messages?' + query
    try:
        with open_browser_page(auth_path, url='https://www.apple.com.cn/shop/buy-iphone') as page:
            result = page.evaluate(STORE_MESSAGES_JS, url)
    except BrowserContextError as error:
        raise ValueError(f'查询门店需要浏览器上下文：{error}') from None
    status = (result or {}).get('status')
    data = (result or {}).get('data')
    if status != 200 or not isinstance(data, dict):
        raise ValueError(f'官网门店接口返回 HTTP {status}，未能读取门店列表。')
    stores = value(data, 'body.content.pickupMessage.stores', None)
    if stores is None:
        stores = value(data, 'body.content.fulfillmentMessages.regular.stores', []) or []
    return [_store_message_summary(store, sku) for store in stores if isinstance(store, dict)]


STORE_MESSAGES_JS = """async (url) => {
  // 先取反爬令牌，否则 fulfillment-messages 会被官网以 541 拒绝。
  try { await fetch('/shop/beacon/atb', { headers: { accept: '*/*' } }); } catch (e) {}
  const response = await fetch(url, { headers: { accept: '*/*' } });
  const text = await response.text();
  try { return { status: response.status, data: JSON.parse(text) }; }
  catch (e) { return { status: response.status, data: null }; }
}"""


def _store_message_summary(store, sku):
    availability = value(store, 'partsAvailability.' + sku, {}) or {}
    quote = (availability.get('pickupSearchQuote')
             or value(availability, 'messageTypes.regular.storePickupQuote', '')
             or availability.get('pickupDisplay', ''))
    title = value(availability, 'messageTypes.regular.storePickupProductTitle', '') or sku
    return {
        'id': store.get('storeNumber') or store.get('storeId'),
        'name': store.get('storeName'),
        'disabled': availability.get('pickupDisplay') not in (None, 'available', 'inStock'),
        'city': store.get('city') or store.get('storeCity') or '',
        'state': store.get('state') or store.get('storeState') or '',
        'address': _store_address(store.get('storeAddress') or store.get('address')),
        'distance': store.get('storeDistance'),
        'availability': [{'name': title, 'quote': quote}] if quote else [],
    }


def _store_address(raw):
    if isinstance(raw, dict):
        line = raw.get('address2') or raw.get('address') or ''
        postal = raw.get('postalCode') or ''
        return ' '.join(str(part) for part in (line, postal) if part)
    return str(raw or '')


def store_search(auth_path, state='', city='', district='', search='', sku=''):
    """按省 / 市 / 区查询零售店。

    主链路是官网 fulfillment-messages（不依赖购物袋）；该接口对脚本请求经常直接返回
    541 或空列表，所以失败时退回购物袋页的门店定位器——下单选门店用的就是同一条链路。
    """
    if not (state and city and district):
        return store_search_requests(auth_path, state, city, district, search)
    try:
        stores = store_search_messages(auth_path, state, city, district, sku)
    except Exception as error:
        primary_error = str(error)
    else:
        if stores:
            return stores
        primary_error = '官网门店接口（fulfillment-messages）返回了空列表。'
    try:
        return store_search_requests(auth_path, state, city, district, search)
    except Exception as error:
        raise ValueError(f'{primary_error} 备用链路（购物袋门店定位器）也失败：{error}') from None


def configure_address(path, auth_path=None):
    config = read_config(path)
    # 主动配置时每一项均可修改；结账时只补充缺项。
    old = config.get('contact', {})
    config['contact'] = {
        'lastName': ask('收件/取货人姓氏', old.get('lastName', '')),
        'firstName': ask('名字', old.get('firstName', '')),
        'emailAddress': ask('通知邮箱', old.get('emailAddress', ''), r'[^\s@]+@[^\s@]+\.[^\s@]+'),
        'fullDaytimePhone': ask('手机号码', old.get('fullDaytimePhone', ''), r'\d{11,12}'),
    }
    saved_region = config.get('delivery', {})
    remote_region = current_region(auth_path or path.parent / 'auth.json')
    if remote_region.get('state'):
        old_region = remote_region
        print('默认地区来自 Apple 当前会话：' + ' / '.join(remote_region.values()) + '。可直接删除、修改；回车确认。')
    else:
        old_region = saved_region
        print('官网未返回当前地区，使用本地记录。' if old_region.get('state')
              else '官网未返回当前地区，请手动填写；可能尚未登录或没有地区记录。')
    defaults = dict(old_region)
    region = {}
    for key, label in (('state', '省/直辖市'), ('city', '城市'), ('district', '区/县')):
        region[key] = ask(label, defaults.get(key, ''))
        if region[key].rstrip('省市') != defaults.get(key, '').rstrip('省市'):
            for child in ('city', 'district') if key == 'state' else ('district',) if key == 'city' else ():
                defaults.pop(child, None)
    config['delivery'] = region
    same_region = all(region[k].rstrip('省市') == saved_region.get(k, '').rstrip('省市') for k in region)
    street_default = config.get('address', {}).get('street', '') if same_region else ''
    config['address'] = {'street': ask('详细地址（街道、楼栋、门牌）', street_default)}
    save_config(path, config)
    print(f'快捷地址已保存到 {path}，结账时可选择使用。')
    return {'success': True, 'config_file': str(path)}


def region_data(flow, path, wanted=None, *, prefer_current=False, interactive=True):
    wanted = wanted or {}
    if prefer_current:
        current = flow.require(path)['d']
        if all(current.get(key) for key in ('state', 'city', 'district')):
            wanted = {key: current[key] for key in ('state', 'city', 'district')}
    selected = {}
    for key, label in (('state', '省份'), ('city', '城市'), ('district', '区县')):
        node = flow.require(path)
        data = node['d']
        options = [(o['value'], o.get('label', o['value'])) for o in data.get(key + 'Options', []) if o.get('value')]
        desired = wanted.get(key) or data.get(key)
        matches = list(dict.fromkeys(k for k, title in options if desired in (k, title)))
        if not matches and desired:
            # 优先精确匹配；当前省市范围内唯一的区/县名称才兼容后缀差异。
            suffix = r'[区县]$' if key == 'district' else r'[省市]$'
            normalized = re.sub(suffix, '', str(desired).strip())
            matches = list(dict.fromkeys(k for k, title in options
                                        if normalized in (re.sub(suffix, '', str(k).strip()),
                                                          re.sub(suffix, '', str(title).strip()))))
        if len(matches) == 1 and matches[0] != desired:
            print(f'{label}自动匹配：{desired} → {matches[0]}')
        elif len(matches) != 1 and desired and interactive:
            print(f'配置中的{label}“{desired}”无法唯一匹配官网选项，请确认。')
        if len(matches) == 1:
            chosen = matches[0]
        elif interactive:
            chosen = choose(label, options, data.get(key))
        else:
            # 全自动流程不能卡在提问上：匹配不上就沿用官网当前值。
            if desired:
                print(f'配置中的{label}“{desired}”未匹配官网选项，沿用官网当前值：{data.get(key)}')
            chosen = data.get(key)
        selected[key] = chosen
        payload = {path + '.' + k: data.get(k, '') for k in ('state', 'city', 'district', 'provinceCityDistrict')}
        payload.update({path + '.' + k: v for k, v in selected.items()})
        payload[path + '.countryCode'] = 'CN'
        if chosen != data.get(key) and 'Select' + key in node.get('a', {}):
            # 改省/市时不携带上一地区的下级选择。
            for child in ('city', 'district') if key == 'state' else ('district',) if key == 'city' else ():
                payload[path + '.' + child] = ''
            payload[path + '.provinceCityDistrict'] = ''
            flow.action(path, 'Select' + key, payload)
    return {**{path + '.' + key: val for key, val in selected.items()},
            path + '.countryCode': 'CN', path + '.provinceCityDistrict': ' '.join(selected.values())}


def shipping_options(flow, groups_path, auto=False):
    payload = {}
    for group in flow.require(groups_path).get('c', []):
        options_path = groups_path + '.' + group + '.shipmentOptionsGroups'
        for option in flow.require(options_path).get('c', []):
            path = options_path + '.' + option + '.shippingOptions'
            node = flow.require(path)['d']
            options = [(o['value'], o.get('label') or o.get('title') or
                        ' / '.join(str(o[k]) for k in ('deliveryQuote', 'deliveryTimeSlot', 'shippingCost') if o.get(k)) or o['value'])
                       for o in node.get('options', []) if o.get('value') and not o.get('disabled')]
            if not options:
                raise ValueError('当前商品没有可用配送服务。')
            keys = [key for key, _ in options]
            default = node.get('selectShippingOption')
            if len(options) > 1 and not auto:
                selected = choose('配送服务', options, default)
            else:
                # 全自动：用官网默认配送；没有默认就用第一个可用项。
                selected = default if default in keys else keys[0]
            payload[path + '.selectShippingOption'] = selected
    return payload


def invoice_data(flow, path):
    invoice = value(flow.model, path + '.eFapiaoSelector')
    if not invoice:
        return {}  # 混合自提的发票已在取货联系人页面填写。
    if value(invoice, 'd.selectFapiao') != 'e_personal_fdf':
        raise ValueError('当前仅支持个人电子发票，请先在官网选择。')
    return {path + '.eFapiaoSelector.selectFapiao': 'e_personal_fdf',
            path + '.eFapiaoSelector.ePersonalFapiao.invoiceHeader': value(invoice, 'ePersonalFapiao.d.invoiceHeader', '')}


def verification(flow, path):
    node = value(flow.model, path + '.verificationModule.d', {})
    if node.get('authRequired') is True and not node.get('verificationToken'):
        raise ValueError('当前联系人需要手机验证，请先在官网完成验证；未继续结账。')
    return {path + '.verificationModule.verificationToken': node.get('verificationToken', '')} if node else {}


def pickup_contact(flow, config, config_path):
    path = 'checkout.pickupContact'
    address = path + '.selfPickupContact.selfContact.address'
    flow.require(address)
    payload = verification(flow, address)
    details = contact(config)
    config['contact'] = details
    save_config(config_path, config)
    payload.update({address + '.' + key: val for key, val in details.items()})
    payload.update(invoice_data(flow, path))
    actions = flow.require(path).get('a', {})
    action = next((a for a in ('continueFromPickupContactToShipping', 'continueFromPickupContactToBilling') if a in actions), None)
    if not action:
        raise ValueError('当前取货联系人页面没有支持的继续操作。')
    flow.action(path, action, payload)
    expected = 'Shipping' if action.endswith('Shipping') else 'Billing'
    if value(flow.model, 'checkout.d.page') != expected:
        raise ValueError('取货联系人未通过服务端校验，请检查姓名、手机及邮箱；未继续结账。')
    flow.require('checkout.shipping' if action.endswith('Shipping') else 'checkout.billing')


def home_delivery(flow, config):
    path = 'checkout.fulfillment'
    selector = path + '.fulfillmentOptions'
    payload = {selector + '.selectFulfillmentLocation': 'HOME'}
    if flow.require(selector)['d'].get('selectFulfillmentLocation') != 'HOME':
        flow.action(selector, 'selectFulfillmentLocationAction', payload)
    if flow.require(selector)['d'].get('selectFulfillmentLocation') != 'HOME':
        raise ValueError('服务端未确认切换为送货，已停止。')
    tab = path + '.deliveryTab.delivery'
    payload.update(region_data(flow, tab + '.deliveryLocation.address.provinceCityDistrictTabsForCheckout', config.get('delivery'), prefer_current=True))
    payload.update(shipping_options(flow, tab + '.shipmentGroups', auto_checkout(config)))
    flow.action(path, 'continueFromFulfillmentToShipping', payload)
    flow.require('checkout.shipping')


def fulfillment(flow, config_path):
    config = read_config(config_path)
    path = 'checkout.fulfillment'
    node = flow.require(path + '.fulfillmentOptions')['d']
    options = [(o['value'], o.get('title', o['value'])) for o in node.get('options', [])
               if o.get('value') in ('HOME', 'RETAIL') and not o.get('disabled')]
    values = [value for value, _ in options]
    preset = config.get('store') if isinstance(config.get('store'), dict) else None
    auto = auto_checkout(config)
    # 每个账号只用一个送货方式；没有预设时沿用旧逻辑（有门店默认自提，全自动优先自提）。
    preferred = {'delivery': 'HOME', 'pickup': 'RETAIL'}.get(config.get('delivery_method'))
    if preferred and preferred in values:
        mode = preferred
        print('按本地送货方式预设：' + ('门店自提' if mode == 'RETAIL' else '快递配送') + '。')
    elif preferred:
        other = 'RETAIL' if preferred == 'HOME' else 'HOME'
        if other not in values:
            raise ValueError('当前商品既不支持配送也不支持自提，请检查购物袋。')
        mode = other
        print('本地预设的送货方式当前不可用，已改为' + ('门店自提' if mode == 'RETAIL' else '快递配送') + '。')
    elif auto and preset and 'RETAIL' in values:
        mode = 'RETAIL'  # 已预设门店 + 全自动：优先自提。
    elif auto and 'HOME' in values:
        mode = 'HOME'
    elif auto and 'RETAIL' in values:
        mode = 'RETAIL'
    else:
        # 优先自提：有预设门店且官网可选自提时，默认选中自提。
        mode = choose('收货方式', options, 'RETAIL' if preset and 'RETAIL' in values else 'HOME')
    if mode != node.get('selectFulfillmentLocation'):
        flow.action(path + '.fulfillmentOptions', 'selectFulfillmentLocationAction',
                    {path + '.fulfillmentOptions.selectFulfillmentLocation': mode})
    payload = {path + '.fulfillmentOptions.selectFulfillmentLocation': mode}
    if mode == 'HOME':
        home_delivery(flow, config)
        if preferred == 'RETAIL':
            return '本地预设是门店自提，但这次下单没有可用的自提门店，已改为快递配送。'
        return ''
    locator = path + '.pickupTab.pickup.storeLocator'
    node = flow.require(locator)
    # 自提页的地区要先切到预设地区：官网只按当前地区返回并按距离排序门店，
    # 否则会在上一个地区里搜索，“就近自提”就选不到正确的门店。
    region = locator + '.address.stateCitySelectorForCheckout'
    wanted = {key: ((preset or {}).get(key) or config.get('delivery', {}).get(key, '') or '')
              for key in ('state', 'city', 'district')}
    flow.require(region)
    picked = region_data(flow, region, wanted, interactive=False) if any(wanted.values()) else {}
    node = flow.require(locator)
    search = (wanted['city'] or wanted['state'] or value(node, 'd.searchInput', ''))
    store_data = {locator + '.showAllStores': 'false', locator + '.selectStore': '', locator + '.searchInput': search}
    store_data.update(picked or {region + '.' + k: value(flow.model, region + '.d.' + k, '')
                                 for k in ('state', 'city', 'district', 'provinceCityDistrict', 'countryCode')})
    flow.action(locator, 'search', store_data)
    stores = value(flow.model, locator + '.searchResults.d.retailStores', [])
    choices = []
    for store in stores:
        lines = value(store, 'availability.lineItemAvailability', [])
        status = '；'.join(str(line.get('partName', '商品')) + '：' + str(line.get('availabilityQuote', '未知')) for line in lines)
        title = str(store.get('storeName', store['storeId'])) + ' — ' + status
        if store.get('storeDisabled') is True:
            print('不可选：' + title)
        else:
            choices.append((store['storeId'], title))
    no_stores = not choices
    delivery_available = any(o.get('value') == 'HOME' and not o.get('disabled')
                             for o in flow.require(path + '.fulfillmentOptions')['d'].get('options', []))
    preset_id = (preset or {}).get('id')
    note = ''
    if no_stores:
        if not delivery_available:
            raise ValueError('当前地区与商品都没有可选的自提门店，也没有可用的送货方式，已停止。')
        print('该地区当前没有可选自提门店，改为送货。')
        region_text = ' '.join(part for part in wanted.values() if part)
        note = '没有' + (region_text + ' ') + '可用的自提门店，已改为快递配送。'
        selected = 'HOME'
    elif preset_id and any(value_ == preset_id for value_, _ in choices):
        # 旧配置指定的门店仍可自提：直接用它。
        print('使用预设自提门店：' + str((preset or {}).get('name') or preset_id))
        selected = preset_id
    else:
        # 就近自提：官网按距离返回门店，自动选第一家可选门店，避免指定门店没货。
        if preset_id:
            print('预设自提门店当前不可选，改为自动就近选择。')
        selected = choices[0][0]
        print('就近自提：自动选择 ' + choices[0][1])
        note = '门店自提：已自动选择最近有货的门店——' + choices[0][1].split(' — ')[0] + '。'
    if selected == 'HOME':
        home_delivery(flow, config)
        return note
    store_data[locator + '.selectStore'] = selected
    flow.action(locator, 'select', store_data)
    if value(flow.model, locator + '.d.selectStore') != selected:
        raise ValueError('服务端未确认所选自提门店，已停止。')
    payload.update(store_data)
    forced = path + '.pickupTab.deliveryForced'
    if value(flow.model, forced + '.shipmentGroups'):
        print('此订单包含必须配送的商品，继续配置送货地区和配送服务。')
        payload.update(region_data(flow, forced + '.deliveryLocation.address.provinceCityDistrictTabsForCheckout', config.get('delivery'), prefer_current=True))
        payload.update(shipping_options(flow, forced + '.shipmentGroups', auto_checkout(config)))
    flow.action(path, 'continueFromFulfillmentToPickupContact', payload)
    flow.require('checkout.pickupContact')
    pickup_contact(flow, config, config_path)
    return note


def shipping(flow, config_path, auth_path=None, auto=None):
    if value(flow.model, 'checkout.d.page') == 'Billing':
        flow.require('checkout.billing')
        return  # 纯自提没有收货地址步骤。
    path = 'checkout.shipping'
    node = flow.require(path)
    # 只有全自动下单才需要提前知道本地快捷地址，其余情况保持“不读本地预设”的行为。
    preset_state = {}

    def preset_ready():
        if 'ready' not in preset_state:
            preset_state['ready'] = preset_complete(read_config(config_path))
        return preset_state['ready']

    selector = node['addressSelector']['d']
    saved = [a for a in selector.get('radioAddresses', [])
             if a.get('isSavedAddress') and a.get('addressLine1') and a.get('value')
             and a['value'] != 'newAddr' and not a.get('disabled')]
    current = next((a for a in saved if a['value'] == selector.get('selectAddress')), None)
    defaults = [a for a in saved if a.get('isDefaultAddr') is True]
    if current is None and len(defaults) == 1:
        current = defaults[0]
    if current is None and len(saved) == 1:
        current = saved[0]
    can_add = any(a.get('value') == 'newAddr' and not a.get('disabled')
                  for a in selector.get('radioAddresses', []))
    if auto and can_add and preset_ready():
        selected = 'newAddr'  # 已填好本地快捷地址，全自动下单不再询问。
        print('全自动下单：使用本地快捷地址。')
    elif auto and current is not None:
        selected = current['value']
    elif auto and len(saved) == 1:
        selected = saved[0]['value']
    elif saved:
        choices = [('saved', '使用官网已有的地址')]
        if can_add:
            choices.append(('newAddr', '使用本地快捷地址进行配置'))
        else:
            print('官网当前未提供可用的新增地址入口，只能使用已有地址。')
        selected = choose('选择送货地址来源', choices, 'saved')
    elif can_add:
        selected = 'newAddr'
        print('官网没有可用的已保存地址，使用本地快捷地址。')
    else:
        raise ValueError('官网没有可用的收货地址，也未提供新增地址入口，已停止。')
    if selected == 'saved':
        selected = current['value'] if current else choose('官网有多个地址且未指定默认，请选择',
                    [(a['value'], str(a.get('provinceCityDistrict', '')) + ' ' + str(a['addressLine1'])) for a in saved])
        current = next(a for a in saved if a['value'] == selected)
        print('使用官网已保存地址：' + str(current.get('provinceCityDistrict', '')) + ' ' + str(current['addressLine1']))
    payload = {path + '.addressSelector.selectAddress': selected}
    if selected == 'newAddr':
        if not preset_ready():
            if auth_path is None:
                configure_address(config_path)
            else:
                configure_address(config_path, auth_path)
        config = read_config(config_path)
        details = contact(config)
        config['contact'] = details
        save_config(config_path, config)
        address = path + '.addressSelector.newAddress.address'
        flow.require(address)
        payload.update(region_data(flow, address + '.stateCitySelectorForCheckout', config.get('delivery')))
        payload.update({address + '.' + k: details[k] for k in ('lastName', 'firstName')})
        payload.update({address + '.street': config['address']['street'], address + '.street2': config.get('address', {}).get('street2', ''),
                        address + '.copyContact.fullDaytimePhone': details['fullDaytimePhone'],
                        path + '.addressSelector.newAddress.saveToAddressBook': 'true'})
        email = details['emailAddress']
        print('收货地址：' + ' '.join(config['delivery'].values()) + ' ' + config['address']['street'])
    else:
        details = {}
        email = value(flow.model, path + '.addressNotification.address.d.emailAddress', '')
    payload.update(invoice_data(flow, path))
    if value(flow.model, path + '.addressNotification.address') is not None:
        optional = value(flow.model, path + '.addressNotification.address.b.emailAddress.optional') is True
        payload[path + '.addressNotification.address.emailAddress'] = email if email or optional else ask('通知邮箱', pattern=r'[^\s@]+@[^\s@]+\.[^\s@]+')
    phone_path = path + '.addressContactPhone.address'
    phone = value(flow.model, phone_path)
    if phone:
        payload.update(verification(flow, phone_path))
        if value(phone, 'b.mobilePhone.submit') is True:
            number = (details.get('fullDaytimePhone') if selected == 'newAddr' else value(phone, 'd.mobilePhone', '')) or ''
            if not re.fullmatch(r'\d{11,12}', number):
                number = ask('收货手机号码', pattern=r'\d{11,12}')
            payload[phone_path + '.mobilePhone'] = number
    flow.action(path, 'continueFromShippingToBilling', payload)
    if value(flow.model, 'checkout.d.page') != 'Billing':
        raise ValueError('收货地址或联系方式未通过服务端校验，请检查后重试；未提交订单。')
    flow.require('checkout.billing')
