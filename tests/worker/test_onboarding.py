import io
import json
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
import requests
from unittest.mock import Mock, patch

import alipay_qr
import interaction
import duo_killer
from protocol import Channel
from service import Service


class AccountCheckTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        for name in ('ROOT', 'AUTH_PATH', 'LOG_PATH', 'PAYMENT_ROOT'):
            self.stack.enter_context(patch.object(duo_killer, name, getattr(duo_killer, name)))
        self.stack.enter_context(patch.object(alipay_qr, 'ROOT', alipay_qr.ROOT))
        self.stack.enter_context(patch.object(interaction, 'handler', None))
        self.service = Service(Channel('a', 't', io.StringIO()), root, root, 'a@example.test', Mock())
        self.service.ensure_auth_file()
        self.person = {'success': True, 'logged_in': True, 'scope': 'account', 'apple_id': 'a@example.test'}
        self.info = self.stack.enter_context(patch.object(duo_killer, 'account_info', return_value=self.person))
        self.login = self.stack.enter_context(patch.object(duo_killer, 'login'))
        self.save = self.stack.enter_context(patch.object(duo_killer, 'save_auth'))
        self.stack.enter_context(patch.object(duo_killer, 'load_auth'))

    def test_valid_account_is_queried_without_login(self):
        self.assertEqual(self.service.run('me', {}), self.person)
        self.info.assert_called_once()
        self.login.assert_not_called()

    def test_failed_query_performs_one_login_then_queries_current_person(self):
        self.info.side_effect = [ValueError('未取得账号信息'), self.person]
        self.assertEqual(self.service.run('me', {}), self.person)
        self.login.assert_called_once_with()
        self.assertEqual(self.info.call_count, 2)

    def test_missing_identity_also_triggers_login(self):
        self.info.side_effect = [{'success': True, 'logged_in': False}, self.person]
        self.assertEqual(self.service.run('me', {}), self.person)
        self.login.assert_called_once_with()

    def test_account_page_reauthentication_is_not_followed_by_another_login(self):
        def reauthenticate(session):
            self.service.authentication_requested = True
            return self.person
        self.info.side_effect = reauthenticate
        self.assertEqual(self.service.run('me', {}), self.person)
        self.login.assert_not_called()

    def test_wrong_password_or_otp_does_not_retry_login(self):
        def rejected(session):
            self.service.authentication_requested = True
            raise ValueError('401 -20101')
        self.info.side_effect = rejected
        with self.assertRaisesRegex(ValueError, '-20101'):
            self.service.run('me', {})
        self.login.assert_not_called()
        self.service.vault.save.assert_not_called()

    def test_failed_relogin_marks_account_for_removal_and_clears_credentials(self):
        self.info.return_value = {'logged_in': False}
        self.login.side_effect = ValueError('认证失败')
        with self.assertRaises(ValueError) as caught:
            self.service.run('me', {})
        self.assertTrue(self.service.should_remove_account(caught.exception))
        self.service.cleanup_credentials(caught.exception)
        self.assertFalse(self.service.auth.exists())
        self.service.vault.delete.assert_called_once_with('a')
        self.login.assert_called_once()

    def test_identity_still_missing_after_relogin_marks_account_invalid(self):
        self.info.return_value = {'success': True, 'logged_in': False}
        with self.assertRaises(ValueError) as caught:
            self.service.run('me', {})
        self.assertTrue(self.service.should_remove_account(caught.exception))
        self.assertEqual(self.info.call_count, 2)
        self.login.assert_called_once()

    def test_network_or_server_failure_after_relogin_keeps_account(self):
        from apple_login import LoginError
        for error in [requests.Timeout('离线'), ValueError('服务暂不可用')]:
            if isinstance(error, ValueError):
                error.__cause__ = LoginError('服务暂不可用', status=503)
            self.info.side_effect = [ValueError('未确认登录'), error]
            with self.assertRaises(type(error)) as caught:
                self.service.run('me', {})
            self.assertFalse(self.service.should_remove_account(caught.exception))

    def test_transient_site_failure_does_not_start_a_full_relogin(self):
        """官网 5xx / 429 时重登只会撞上同一个错误，应直接让用户稍后重试。"""
        from apple_login import LoginError
        error = ValueError('Apple 官网暂时不可用（HTTP 503，错误代码 []）：请稍后重试；账号与本地配置已保留。')
        error.__cause__ = LoginError('官网暂时不可用', status=503)
        self.info.side_effect = error
        with self.assertRaises(ValueError) as caught:
            self.service.run('me', {})
        self.assertEqual(self.info.call_count, 1)
        self.login.assert_not_called()
        self.assertFalse(self.service.should_remove_account(caught.exception))
        self.assertIn('官网暂时不可用', str(caught.exception))

    def test_transient_status_is_read_from_wrapped_and_bare_errors(self):
        from apple_login import LoginError
        for status in (429, 502, 503, 504):
            with self.subTest(status=status):
                self.assertEqual(self.service.transient_status(LoginError('x', status=status)), status)
                wrapped = ValueError('wrapped')
                wrapped.__cause__ = LoginError('x', status=status)
                self.assertEqual(self.service.transient_status(wrapped), status)
        for status in (401, 403, 409, 541):
            self.assertIsNone(self.service.transient_status(LoginError('x', status=status)), status)
        self.assertIsNone(self.service.transient_status(ValueError('没有状态码')))
        self.assertIsNone(self.service.transient_status(requests.Timeout('离线')))

    def test_business_errors_cancel_and_first_enrollment_do_not_remove_account(self):
        from protocol import Cancelled
        self.service.action = 'checkout'
        self.service.authentication_requested = True
        self.assertFalse(self.service.should_remove_account(ValueError('商品无货')))
        self.service.authentication_failed = True
        self.assertFalse(self.service.should_remove_account(Cancelled()))
        self.service.action = 'enroll'
        self.assertFalse(self.service.should_remove_account(ValueError('密码错误')))
        self.service.action = 'checkout'
        self.service.submitted = True
        self.assertFalse(self.service.should_remove_account(ValueError('会话失效')))

    def test_checkout_and_orders_still_requiring_login_mark_account_invalid(self):
        for action in ('checkout', 'orders'):
            with self.subTest(action=action):
                self.service.action = action
                self.service.authentication_failed = False
                flow = Mock()
                flow.url = 'https://secure8.www.apple.com.cn/shop/signIn' + ('/orders' if action == 'orders' else '')
                flow.model = {}
                with patch('apple_login.load_credentials', return_value=('a@example.test', 'test-password')), \
                        patch('apple_login.AppleStoreLogin.login') as login, \
                        patch.object(duo_killer, 'Checkout', return_value=flow):
                    with self.assertRaises(ValueError) as caught:
                        if action == 'orders':
                            duo_killer.order_list(requests.Session())
                        else:
                            duo_killer.reauthenticate_checkout(flow)
                    login.assert_called_once()
                    self.assertTrue(self.service.should_remove_account(caught.exception))

    def test_failed_fallback_does_not_restore_old_cookies(self):
        self.info.return_value = {'logged_in': False}
        self.login.side_effect = ValueError('登录失败')
        with self.assertRaisesRegex(ValueError, '登录失败'):
            self.service.run('me', {})
        self.save.assert_not_called()

    def test_enrollment_logs_in_before_checking_person(self):
        order = []
        self.login.side_effect = lambda: order.append('login')
        self.info.side_effect = lambda session: order.append('me') or self.person
        self.assertEqual(self.service.run('enroll', {}), self.person)
        self.assertEqual(order, ['login', 'me'])

    def test_enrollment_does_not_succeed_with_only_store_menu_login(self):
        self.info.return_value = {'success': True, 'logged_in': False}
        with self.assertRaisesRegex(ValueError, '无法确认当前账号'):
            self.service.run('enroll', {})
        self.login.assert_called_once_with()
        self.service.vault.save.assert_not_called()
