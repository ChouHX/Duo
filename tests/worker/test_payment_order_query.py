import contextlib
import io
import unittest
from unittest.mock import patch

import requests

import duo_killer


class PaymentOrderQueryTests(unittest.TestCase):
    def test_only_enter_queries_and_can_refresh_without_resubmission(self):
        events = []
        def reply(prompt):
            self.assertIn('👉', prompt)
            self.assertEqual(events.count('query'), events.count('enter'))
            if events.count('enter') < 2:
                events.append('enter')
                return ''
            return 'q'
        def query(session):
            events.append('query')
            return {'success': True, 'orders': [], 'message': '查询完成'}
        with patch('builtins.input', side_effect=reply), patch.object(duo_killer, 'authenticate') as auth, \
                patch.object(duo_killer, 'order_list', side_effect=query) as orders, \
                patch.object(duo_killer, 'save_auth') as save, patch.object(duo_killer, 'pay_bag') as pay, \
                patch.object(duo_killer, 'add_to_bag') as add, contextlib.redirect_stdout(io.StringIO()) as output:
            duo_killer.wait_for_order_query()
        self.assertEqual(events, ['enter', 'query', 'enter', 'query'])
        self.assertEqual(orders.call_count, 2)
        self.assertEqual(save.call_count, 2)
        self.assertTrue(all(c.kwargs == {'strong': True} for c in auth.call_args_list))
        self.assertEqual(output.getvalue().count('查询完成'), 2)
        pay.assert_not_called()
        add.assert_not_called()

    def test_query_failure_allows_manual_retry(self):
        with patch('builtins.input', side_effect=['', '', 'q']), patch.object(duo_killer, 'authenticate'), \
                patch.object(duo_killer, 'order_list', side_effect=[requests.Timeout('private-token'),
                    {'orders': [], 'message': '刷新完成'}]) as orders, patch.object(duo_killer, 'save_auth'), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            duo_killer.wait_for_order_query()
        self.assertEqual(orders.call_count, 2)
        self.assertIn('订单查询失败', output.getvalue())
        self.assertIn('刷新完成', output.getvalue())
        self.assertNotIn('private-token', output.getvalue())

    def test_exit_or_cancel_does_not_query(self):
        for reply in ('q', EOFError(), KeyboardInterrupt()):
            with self.subTest(reply=type(reply).__name__), patch('builtins.input', side_effect=[reply]), \
                    patch.object(duo_killer, 'authenticate') as auth, patch.object(duo_killer, 'order_list') as query, \
                    contextlib.redirect_stdout(io.StringIO()):
                duo_killer.wait_for_order_query()
            auth.assert_not_called()
            query.assert_not_called()

    def test_noninteractive_qr_result_does_not_wait(self):
        with patch.object(duo_killer, 'pay_bag', return_value={'success': True, 'qr_image': '/tmp/qr.png'}), \
                patch.object(duo_killer.sys.stdin, 'isatty', return_value=False), \
                patch.object(duo_killer, 'wait_for_order_query') as wait, contextlib.redirect_stdout(io.StringIO()):
            duo_killer.main(['-p'])
        wait.assert_not_called()

    def test_no_qr_does_not_wait(self):
        with patch.object(duo_killer, 'pay_bag', return_value={'success': True, 'qr_image': None}), \
                patch.object(duo_killer.sys.stdin, 'isatty', return_value=True), \
                contextlib.redirect_stdout(io.StringIO()), \
                patch.object(duo_killer.sys.stdout, 'isatty', return_value=True), \
                patch.object(duo_killer, 'wait_for_order_query') as wait:
            duo_killer.main(['-p'])
        wait.assert_not_called()


if __name__ == '__main__':
    unittest.main()
