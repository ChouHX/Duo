import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from contextlib import ExitStack

import duo_killer
import interaction
import alipay_qr
from service import Service
from protocol import Channel


class PublicPagesTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        for name in ('ROOT', 'AUTH_PATH', 'LOG_PATH', 'PAYMENT_ROOT'):
            stack.enter_context(patch.object(duo_killer, name, getattr(duo_killer, name)))
        stack.enter_context(patch.object(interaction, 'handler', None))
        stack.enter_context(patch.object(alipay_qr, 'ROOT', alipay_qr.ROOT))
        self.vault = Mock()
        self.service = Service(Channel('00000000-0000-0000-0000-000000000000', 't', io.StringIO()), self.root, self.root, '', self.vault)

    def test_public_duo_never_creates_auth_or_reads_vault(self):
        result = {'success': True, 'items': [{'sku': 'MK2U4CH/A', 'can_add_to_bag': None}]}
        with patch('shop_catalog.query_duo', return_value=result) as query, patch.object(duo_killer, 'login') as login:
            self.assertEqual(self.service.run('catalog', {'mode': 'duo'}), result)
        query.assert_called_once_with(duo_killer.request_get)
        login.assert_not_called()
        self.vault.get.assert_not_called()
        self.assertFalse(self.service.auth.exists())

    def test_public_failure_is_not_a_stock_result(self):
        with patch('shop_catalog.query_duo', side_effect=ValueError('商品页查询失败：HTTP 541')):
            with self.assertRaisesRegex(ValueError, '541'):
                self.service.run('catalog', {'mode': 'duo'})
        self.assertFalse(self.service.auth.exists())

    def test_address_saved_without_authentication(self):
        address = {'contact': {'lastName': '测', 'firstName': '试', 'emailAddress': 'test@example.test', 'fullDaytimePhone': '13800000000'},
                   'delivery': {'state': '四川', 'city': '成都', 'district': '锦江区'}, 'address': {'street': '测试路 1 号'}}
        self.service.run('address_save', address)
        self.assertEqual(self.service.run('address_read', {})['config'], address)
        self.assertEqual(json.loads(self.service.checkout.read_text()), address)
        self.assertFalse(self.service.auth.exists())
        self.vault.get.assert_not_called()
