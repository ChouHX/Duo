import os
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import duo_killer
import checkout_options


def address_config():
    return {'contact': {'lastName': '测试', 'firstName': '用户', 'emailAddress': 'test@example.invalid',
                        'fullDaytimePhone': '13800000000'},
            'delivery': {'state': '四川', 'city': '成都', 'district': '双流区'},
            'address': {'street': '测试街道'}}


class InitializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.auth = self.root / 'auth.json'
        self.auth.write_text(json.dumps({'account': 'test@example.invalid', 'password': 'secret', 'cookies': {
            'account_session': [], 'server_managed': [], 'with_expiry': [], 'expiry_unknown': []}}))
        for target, attr, val in ((duo_killer, 'ROOT', self.root), (duo_killer, 'AUTH_PATH', self.auth),
                                  (duo_killer, 'DEFAULT_PURCHASE_SKU', 'MK2U4CH')):
            patcher = patch.object(target, attr, val)
            patcher.start()
            self.addCleanup(patcher.stop)
        out = contextlib.redirect_stdout(io.StringIO())
        out.__enter__()
        self.addCleanup(out.__exit__, None, None, None)
        for target in ('duo_killer.ensure_strong_login', 'duo_killer.check_login', 'duo_killer.login',
                       'requests.Session.request'):
            guard = patch(target, side_effect=AssertionError('初始化不应执行登录或网络请求'))
            guard.start()
            self.addCleanup(guard.stop)
        self.real_account_info = duo_killer.account_info
        account = patch.object(duo_killer, 'account_info', return_value={
            'logged_in': True, 'name': '测试用户', 'apple_id': 'test@example.invalid'})
        self.account_query = account.start()
        self.addCleanup(account.stop)
        prompt = patch('builtins.input', return_value='n')
        prompt.start()
        self.addCleanup(prompt.stop)

    def test_no_arguments_run_initialization_only(self):
        with patch.object(duo_killer, 'initialize', return_value={'success': True}) as init, \
                patch.object(duo_killer, 'purchase_sku') as buy, patch.object(duo_killer, 'pay_bag') as pay:
            duo_killer.main([])
        init.assert_called_once_with()
        buy.assert_not_called()
        pay.assert_not_called()

    def test_default_and_existing_sku_saved_after_local_address_setup(self):
        for existing, expected in ((None, 'MK2U4CH/A'), ('mlh74fe', 'MLH74FE/A')):
            with self.subTest(existing=existing):
                config = {'delivery': {'state': '四川'}, 'other': 'keep'}
                if existing:
                    config['purchase'] = {'sku': existing, 'other': 'keep'}
                checkout_options.save_config(self.root / 'checkout.json', config)
                events = []
                def configure(path, auth_path):
                    self.assertEqual(auth_path, self.auth)
                    events.append('address')
                    checkout_options.save_config(path, {**config, **address_config()})
                with patch.object(checkout_options, 'configure_address', side_effect=configure), \
                        patch.object(checkout_options, 'ask', side_effect=lambda label, default: events.append('sku') or default):
                    result = duo_killer.initialize()
                self.assertEqual(events, ['address'] + ([] if existing else ['sku']))
                saved = checkout_options.read_config(self.root / 'checkout.json')
                self.assertEqual(saved['purchase']['sku'], expected)
                self.assertEqual(saved['other'], 'keep')
                self.assertEqual(saved['delivery'], address_config()['delivery'])
                self.assertEqual(result['default_sku'], expected)
                if os.name != 'nt':  # Windows uses inherited per-user ACLs, not POSIX mode bits.
                    self.assertEqual((self.root / 'checkout.json').stat().st_mode & 0o777, 0o600)

    def test_invalid_auth_prevents_address_configuration_without_overwriting_file(self):
        for content in ('{broken', '[]'):
            with self.subTest(content=content):
                self.auth.write_text(content)
                with patch.object(checkout_options, 'configure_address') as address, \
                        patch.object(checkout_options, 'ask') as sku, \
                        self.assertRaisesRegex(ValueError, 'auth.json'):
                    duo_killer.initialize()
                address.assert_not_called()
                sku.assert_not_called()
                self.assertEqual(self.auth.read_text(), content)
                self.assertFalse((self.root / 'checkout.json').exists())

    def test_invalid_sku_can_be_corrected_locally(self):
        checkout_options.save_config(self.root / 'checkout.json', address_config())
        with patch.object(checkout_options, 'configure_address'), \
                patch.object(checkout_options, 'ask', side_effect=['not-a-sku', 'mk2u4ch']) as prompt:
            result = duo_killer.initialize()
        self.assertEqual(prompt.call_count, 2)
        self.assertEqual(result['default_sku'], 'MK2U4CH/A')

    def test_missing_credentials_are_saved_without_login(self):
        checkout_options.save_config(self.root / 'checkout.json',
                                     {**address_config(), 'purchase': {'sku': 'MK2U4CH/A'}})
        for existing in (None, {'account': '', 'password': '', 'cookies': {
                'account_session': [], 'server_managed': [], 'with_expiry': [], 'expiry_unknown': []}}):
            with self.subTest(existing=existing):
                if existing is None:
                    self.auth.unlink()
                else:
                    self.auth.write_text(json.dumps(existing))
                with patch('builtins.input', side_effect=['test@example.invalid', 'secret', 'n']):
                    result = duo_killer.initialize()
                self.assertTrue(result['initialized'])
                saved = json.loads(self.auth.read_text())
                self.assertEqual(saved['account'], 'test@example.invalid')
                self.assertEqual(saved['password'], 'secret')

    def test_complete_checkout_config_is_not_rewritten_by_account_query(self):
        config_path = self.root / 'checkout.json'
        checkout_options.save_config(config_path, {**address_config(), 'purchase': {'sku': 'MK2U4CH/A'}})
        for cookies in ([], [{'name': 'as_ltn_cn', 'value': 'expired', 'expires': 1,
                              'domain': '.apple.com.cn', 'path': '/'}]):
            with self.subTest(expired=bool(cookies)):
                auth = json.loads(self.auth.read_text())
                auth['cookies']['account_session'] = cookies
                self.auth.write_text(json.dumps(auth))
                before = (config_path.read_bytes(), config_path.stat().st_mtime_ns)
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    result = duo_killer.initialize()
                self.assertTrue(result['initialized'])
                self.assertNotIn('商城已登录', output.getvalue())
                self.assertIn('全部本地配置已完成', output.getvalue())
                self.assertEqual(before, (config_path.read_bytes(), config_path.stat().st_mtime_ns))
                self.assertEqual(json.loads(self.auth.read_text())['password'], 'secret')

    def test_initialization_displays_remote_identity_without_reauthentication(self):
        checkout_options.save_config(self.root / 'checkout.json',
                                     {**address_config(), 'purchase': {'sku': 'MK2U4CH/A'}})
        self.account_query.return_value = {'logged_in': True, 'name': '测试用户',
                                          'apple_id': 'remote@example.invalid'}
        with contextlib.redirect_stdout(io.StringIO()) as output:
            duo_killer.initialize()
        self.account_query.assert_called_once()
        self.assertEqual(self.account_query.call_args.kwargs, {})
        self.assertIn('当前登录人：测试用户（remote@example.invalid）', output.getvalue())

    def test_query_errors_stop_without_homepage_login_or_purchase(self):
        checkout_options.save_config(self.root / 'checkout.json',
                                     {**address_config(), 'purchase': {'sku': 'MK2U4CH/A'}})
        for error in (duo_killer.requests.Timeout('network'), ValueError('账号或密码错误')):
            with self.subTest(error=type(error).__name__):
                self.account_query.reset_mock()
                self.account_query.side_effect = error
                with patch.object(duo_killer, 'login') as login, patch('builtins.input') as prompt, \
                        patch.object(duo_killer, 'purchase_sku') as buy, self.assertRaises(type(error)):
                    duo_killer.initialize()
                login.assert_not_called()
                self.account_query.assert_called_once()
                prompt.assert_not_called()
                buy.assert_not_called()

    def test_direct_account_authentication_reuses_page_and_saves_current_session(self):
        from apple_login import AppleStoreLogin

        checkout_options.save_config(self.root / 'checkout.json',
                                     {**address_config(), 'purchase': {'sku': 'MK2U4CH/A'}})
        entry = 'https://secure6.www.apple.com.cn/shop/signIn/account?ssi=account-context'
        def page(model, url):
            result = duo_killer.requests.Response()
            result.status_code = 200
            result.url = url
            result._content = ('<script id="init_data">' + json.dumps(model) + '</script>').encode()
            return result
        signin = page({'signIn': {}}, entry)
        landing = page({'home': {'d': {'signOutUrl': '/shop/signOut', 'firstName': '用户'},
                                 'customerAccount': {'d': {'appleId': 'test@example.invalid'}}}},
                       'https://secure6.www.apple.com.cn/shop/account/home')
        def account_login(client, account, password, *, signin_url, signin_response):
            self.assertEqual(signin_url, entry)
            self.assertIs(signin_response, signin)
            client.session.cookies.set('as_ltn_cn', 'account-fresh', domain='.apple.com.cn', path='/')
            return landing
        self.account_query.side_effect = self.real_account_info
        with patch.object(duo_killer, 'request_get', return_value=signin) as request, \
                patch.object(duo_killer, 'login') as store_login, \
                patch.object(AppleStoreLogin, 'login', autospec=True, side_effect=account_login) as account_login_mock:
            result = duo_killer.initialize()
        self.assertTrue(result['initialized'])
        store_login.assert_not_called()
        request.assert_called_once()
        account_login_mock.assert_called_once()
        cookies = json.loads(self.auth.read_text())['cookies']['account_session']
        self.assertTrue(any(c['name'] == 'as_ltn_cn' and c['value'] == 'account-fresh' for c in cookies))

    def test_unconfirmed_identity_stops_without_retry(self):
        checkout_options.save_config(self.root / 'checkout.json',
                                     {**address_config(), 'purchase': {'sku': 'MK2U4CH/A'}})
        for result in ({'logged_in': False}, {'logged_in': True}):
            with self.subTest(result=result):
                self.account_query.reset_mock()
                self.account_query.return_value = result
                with patch.object(duo_killer, 'login') as login, patch('builtins.input') as prompt, \
                        patch.object(duo_killer, 'purchase_sku') as buy, \
                        self.assertRaisesRegex(ValueError, '无法确认当前登录人'):
                    duo_killer.initialize()
                login.assert_not_called()
                self.account_query.assert_called_once()
                prompt.assert_not_called()
                buy.assert_not_called()

    def test_completed_setup_enter_buys_two_without_reconfiguring(self):
        for part in ('MK2U4CH', 'MLH74FE/A'):
            with self.subTest(part=part):
                checkout_options.save_config(self.root / 'checkout.json', {**address_config(), 'purchase': {'sku': part}})
                with patch.object(checkout_options, 'configure_address') as address, \
                        patch.object(checkout_options, 'ask') as sku, \
                        patch('builtins.input', return_value='') as prompt, \
                        patch.object(duo_killer, 'purchase_sku', return_value={'success': True, 'status': 'pending_payment'}) as buy:
                    result = duo_killer.initialize()
                address.assert_not_called()
                sku.assert_not_called()
                prompt.assert_called_once()
                self.assertIn('-num 2', prompt.call_args.args[0])
                self.assertIn(duo_killer.normalize_sku(part)[:-2], prompt.call_args.args[0])
                buy.assert_called_once_with(duo_killer.normalize_sku(part), quantity=2)
                self.assertEqual(result['status'], 'pending_payment')

    def test_completed_setup_cancel_or_eof_never_buys(self):
        checkout_options.save_config(self.root / 'checkout.json', {**address_config(), 'purchase': {'sku': 'MK2U4CH'}})
        for reply in ('n', EOFError()):
            with self.subTest(reply=type(reply).__name__), \
                    patch('builtins.input', side_effect=[reply]), patch.object(duo_killer, 'purchase_sku') as buy:
                if isinstance(reply, EOFError):
                    with self.assertRaises(EOFError):
                        duo_killer.initialize()
                else:
                    result = duo_killer.initialize()
                    self.assertIn('未开始购买', result['message'])
                buy.assert_not_called()

    def test_incomplete_address_cannot_be_marked_ready(self):
        config = address_config()
        self.assertTrue(duo_killer.address_preset_ready(config))
        config['contact']['fullDaytimePhone'] = 'invalid'
        self.assertFalse(duo_killer.address_preset_ready(config))
        checkout_options.save_config(self.root / 'checkout.json', config)
        with patch.object(checkout_options, 'configure_address'), patch.object(duo_killer, 'purchase_sku') as buy, \
                self.assertRaisesRegex(ValueError, '地址预设仍不完整'):
            duo_killer.initialize()
        buy.assert_not_called()

    def test_cli_uses_preset_and_explicit_sku_takes_priority(self):
        checkout_options.save_config(self.root / 'checkout.json', {'purchase': {'sku': 'MLH74FE'}})
        for command, handler in (('-k', 'purchase_sku'), ('-a', 'add_to_bag')):
            with self.subTest(command=command), patch.object(duo_killer, handler, return_value={'success': True}) as action:
                duo_killer.main([command, '-num', '2'])
                self.assertEqual(action.call_args.args[0], 'MLH74FE/A')
                self.assertEqual(action.call_args.kwargs['quantity'], 2)
                duo_killer.main([command, 'MK2U4CH'])
                self.assertEqual(action.call_args.args[0], 'MK2U4CH')

    def test_help_does_not_initialize(self):
        with patch.object(duo_killer, 'initialize') as init, self.assertRaises(SystemExit) as stopped:
            duo_killer.main(['-h'])
        self.assertEqual(stopped.exception.code, 0)
        init.assert_not_called()


if __name__ == '__main__':
    unittest.main()
