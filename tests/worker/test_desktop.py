import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import time
import threading
import unittest
from unittest.mock import patch
import uuid

import interaction
import duo_killer
from protocol import Channel, Cancelled
from service import Service, empty_auth, purchase_items, validate_address, validate_import
from platform_support import browser_candidates


class ChannelTests(unittest.TestCase):
    def test_wrong_account_and_stale_prompt_are_ignored(self):
        output=io.StringIO(); channel=Channel('a','t',output)
        ready=threading.Event()
        original_emit=channel.emit
        def emit(*args, **kwargs):
            original_emit(*args, **kwargs)
            ready.set()
        channel.emit=emit
        received=[]
        thread=threading.Thread(target=lambda:received.append(channel.prompt('code','验证码')),daemon=True)
        thread.start()
        self.assertTrue(ready.wait(2))
        request=json.loads(output.getvalue())['prompt']['id']
        channel.receive(dict(type='reply',account_id='other',task_id='t',request_id=request,value='wrong'))
        channel.receive(dict(type='reply',account_id='a',task_id='t',request_id='stale',value='wrong'))
        channel.receive(dict(type='reply',account_id='a',task_id='t',request_id=request,value='012345'))
        thread.join(2)
        self.assertEqual(received,['012345'])
        self.assertNotIn('012345',output.getvalue())

    def test_cancel_unblocks_input(self):
        channel=Channel('a','t',io.StringIO()); channel.receive(dict(type='cancel',account_id='a',task_id='t'))
        with self.assertRaises(Cancelled):channel.prompt('code','验证码')


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.globals = {key: getattr(duo_killer, key) for key in ('ROOT','AUTH_PATH','LOG_PATH','PAYMENT_ROOT')}
        import alipay_qr
        self.qr_root = alipay_qr.ROOT

    def tearDown(self):
        interaction.handler=None
        for key, value in self.globals.items():
            setattr(duo_killer, key, value)
        import alipay_qr
        alipay_qr.ROOT = self.qr_root

    def test_import_strips_password_and_other_domains(self):
        data=empty_auth('a@example.test');data['password']='not-to-persist'
        data['cookies']['account_session']=[dict(name='one',value='fixture',domain='.apple.com.cn'),dict(name='two',value='no',domain='evil.test')]
        cleaned=validate_import(data,'a@example.test')
        self.assertNotIn('password',cleaned)
        self.assertEqual(len(cleaned['cookies']['account_session']),1)
        with self.assertRaises(ValueError):validate_import(data,'b@example.test')

    def test_code_prompt_exposes_only_available_switch_actions(self):
        from unittest.mock import Mock
        cases = [
            ('👉 设备六位验证码（输入 s 改用短信）：', '设备六位验证码：', 's',
             {'actions': [{'value': 's', 'label': '改用短信验证码'}]}),
            ('👉 短信六位验证码（输入 d 改用设备）：', '短信六位验证码：', 'd',
             {'actions': [{'value': 'd', 'label': '改用设备验证码'}]}),
            ('👉 设备六位验证码：', '设备六位验证码：', '012345', {}),
        ]
        with tempfile.TemporaryDirectory() as directory:
            channel = Mock()
            service = Service(channel, Path(directory), Path(directory), 'fixture', Mock())
            for original, label, answer, fields in cases:
                with self.subTest(label=original):
                    channel.prompt.reset_mock()
                    channel.prompt.return_value = answer
                    self.assertEqual(service.text(original), answer)
                    channel.prompt.assert_called_once_with('code', label, default='', **fields)

    def test_password_failure_forgets_vault_without_losing_identity(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);vault=Mock();service=Service(Channel('a','t',io.StringIO()),root,root,'a@example.test',vault)
            service.ensure_auth_file();service.cleanup_credentials(ValueError('401 -20101'))
            vault.delete.assert_called_once_with('a')
            data=json.loads(service.auth.read_text());self.assertEqual(data['account'],'a@example.test');self.assertNotIn('password',data)

    def test_region_action_returns_region_and_reason(self):
        from unittest.mock import Mock
        import checkout_options
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = Service(Mock(), root, root, 'a@example.test', Mock())
            saved = {'region': {'state': '四川', 'city': '成都'},
                     'contact': {'lastName': '张'}, 'address': {'street': '测试路 1 号'},
                     'states': [{'value': '四川', 'label': '四川'}], 'saved': True}
            with patch.object(checkout_options, 'account_region', return_value=saved):
                result = service.run('region', {})
            self.assertEqual(result['region']['city'], '成都')
            self.assertEqual(result['address']['street'], '测试路 1 号')
            self.assertIn('已读取官网默认收货地址', result['message'])
            with patch.object(checkout_options, 'account_region',
                              return_value={'region': {}, 'contact': {}, 'address': {},
                                            'states': [], 'saved': False}):
                result = service.run('region', {})
            self.assertEqual(result['region'], {})
            self.assertIn('没有默认收货地址', result['message'])

    def test_region_options_action_returns_options(self):
        from unittest.mock import Mock
        import checkout_options
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = Service(Mock(), root, root, 'a@example.test', Mock())
            with patch.object(checkout_options, 'account_region_options',
                              return_value=[{'value': '成都', 'label': '成都'}]) as lookup:
                result = service.run('region_options', {'level': 'city', 'state': '四川'})
            lookup.assert_called_once()
            self.assertEqual(result['options'][0]['value'], '成都')
            self.assertEqual(result['level'], 'city')
            self.assertEqual(result['state'], '四川')

    def test_store_save_and_clear(self):
        from unittest.mock import Mock
        import checkout_options
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = Service(Mock(), root, root, 'a@example.test', Mock())
            result = service.run('store_save', {'store': {'id': 'R580', 'name': '测试门店', 'city': '武汉'}})
            self.assertEqual(result['config']['store']['id'], 'R580')
            self.assertIn('已预设取货门店', result['message'])
            # 只给地区也能保存：下单时自动就近选择。
            result = service.run('store_save', {'store': {'state': '四川', 'city': '成都', 'district': '锦江区'}})
            self.assertEqual(result['config']['store']['city'], '成都')
            self.assertEqual(result['config']['store']['id'], '')
            self.assertIn('已预设取货地区', result['message'])
            self.assertIn('自动选择最近且有货的门店', result['message'])
            result = service.run('store_save', {'store': None})
            self.assertNotIn('store', result['config'])
            self.assertIn('已清除', result['message'])
            with self.assertRaisesRegex(ValueError, '取货地区'):
                service.run('store_save', {'store': {'name': '只有名字'}})

    def test_store_save_records_delivery_method(self):
        from unittest.mock import Mock
        import checkout_options
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = Service(Mock(), root, root, 'a@example.test', Mock())
            result = service.run('store_save', {'method': 'pickup'})
            self.assertEqual(result['config']['delivery_method'], 'pickup')
            self.assertIn('门店自提', result['message'])
            # 只改送货方式时不动已保存的门店。
            service.run('store_save', {'store': {'id': 'R580', 'name': '测试门店', 'city': '武汉'}})
            result = service.run('store_save', {'method': 'delivery'})
            self.assertEqual(result['config']['delivery_method'], 'delivery')
            self.assertEqual(result['config']['store']['id'], 'R580')
            self.assertIn('快递配送', result['message'])
            with self.assertRaisesRegex(ValueError, '送货方式'):
                service.run('store_save', {'method': 'carrier-pigeon'})

    def test_purchase_items_accepts_list_and_single_sku(self):
        # 只校验并原样返回 {sku, quantity} 列表；规整由 duo_killer.normalize_items 负责。
        self.assertEqual(purchase_items({'items': [{'sku': 'mk2u4ch', 'quantity': 2}]}),
                         [{'sku': 'mk2u4ch', 'quantity': 2}])
        self.assertEqual(purchase_items({'items': [{'sku': 'mk2u4ch', 'quantity': 2},
                                                   {'sku': 'mjta4ch', 'quantity': 1}]}),
                         [{'sku': 'mk2u4ch', 'quantity': 2}, {'sku': 'mjta4ch', 'quantity': 1}])
        # 兼容旧的单个 sku + quantity 参数。
        self.assertEqual(purchase_items({'sku': 'mjta4ch', 'quantity': 3}),
                         [{'sku': 'mjta4ch', 'quantity': 3}])
        self.assertEqual(purchase_items({}),
                         [{'sku': duo_killer.DEFAULT_PURCHASE_SKU, 'quantity': 1}])
        # 校验依然生效（错误信息来自 normalize_items）。
        self.assertEqual(duo_killer.normalize_items(purchase_items({'items': [{'sku': 'mk2u4ch', 'quantity': 2}]})),
                         [('MK2U4CH/A', 2)])
        with self.assertRaisesRegex(ValueError, '商品列表'):
            purchase_items({'items': 'MK2U4CH'})
        with self.assertRaises(ValueError):
            purchase_items({'items': []})
        with self.assertRaisesRegex(ValueError, 'SKU'):
            purchase_items({'items': [{'sku': 'nope', 'quantity': 1}]})
        with self.assertRaisesRegex(ValueError, '数量'):
            purchase_items({'items': [{'sku': 'MK2U4CH', 'quantity': 0}]})

    def test_timed_purchase_validates_time_and_warmup(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = Service(Mock(), root, root, 'a@example.test', Mock())
            with self.assertRaisesRegex(ValueError, '抢购时间无效'):
                service.run('timed_purchase', {'items': [{'sku': 'MK2U4CH', 'quantity': 1}], 'at': 'now'})
            with self.assertRaisesRegex(ValueError, '抢购时间无效'):
                service.run('timed_purchase', {'items': [{'sku': 'MK2U4CH', 'quantity': 1}], 'at': 1})
            with self.assertRaisesRegex(ValueError, '预热'):
                service.run('timed_purchase', {'items': [{'sku': 'MK2U4CH', 'quantity': 1}],
                                               'at': time.time() + 600, 'warmup': 99999})
            with patch.object(duo_killer, 'timed_purchase', return_value={'success': True}) as run:
                service.run('timed_purchase', {'items': [{'sku': 'MK2U4CH', 'quantity': 1}],
                                               'at': 2_000_000_000, 'warmup': 120})
            self.assertEqual(run.call_args.kwargs['warmup'], 120)
            self.assertEqual(run.call_args.kwargs['at'], 2_000_000_000.0)
            self.assertEqual(run.call_args.args[0], [{'sku': 'MK2U4CH', 'quantity': 1}])

    def test_orders_pass_items_through_without_double_normalizing(self):
        # 回归：service 校验后的商品必须仍是 {sku, quantity} 字典，不能再被当成条目校验一遍。
        from unittest.mock import Mock
        import duo_killer
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = Service(Mock(), root, root, 'a@example.test', Mock())
            seen = {}

            def fake_purchase(items, **kwargs):
                seen['items'] = items
                return {'success': True, 'bag': duo_killer.normalize_items(items)}

            with patch.object(duo_killer, 'purchase_items', side_effect=fake_purchase):
                result = service.run('purchase', {'items': [{'sku': 'mk2u4ch', 'quantity': 2},
                                                            {'sku': 'MJTA4CH', 'quantity': 1}]})
            self.assertEqual(result['bag'], [('MK2U4CH/A', 2), ('MJTA4CH/A', 1)])
            self.assertTrue(all(isinstance(item, dict) for item in seen['items']))
            with patch.object(duo_killer, 'add_items', side_effect=lambda items, **k: {'ok': duo_killer.normalize_items(items)}):
                self.assertEqual(service.run('add', {'items': [{'sku': 'MK2U4CH', 'quantity': 1}]})['ok'],
                                 [('MK2U4CH/A', 1)])
            with patch.object(duo_killer, 'timed_purchase',
                              side_effect=lambda items, **k: {'ok': duo_killer.normalize_items(items)}) as timed:
                self.assertEqual(service.run('timed_purchase',
                                             {'items': [{'sku': 'MK2U4CH', 'quantity': 2}],
                                              'at': 2_000_000_000, 'warmup': 60})['ok'],
                                 [('MK2U4CH/A', 2)])
            self.assertEqual(timed.call_args.kwargs['warmup'], 60)

    def test_purchase_action_walks_the_whole_chain_to_the_bag(self):
        # 端到端（只挡网络边界）：service → duo_killer.purchase_items → normalize_items → add_to_bag。
        from unittest.mock import Mock
        import duo_killer
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = Service(Mock(), root, root, 'a@example.test', Mock())
            added = []
            with patch.object(duo_killer, 'ensure_auth_file'), \
                    patch.object(duo_killer, 'load_auth'), \
                    patch.object(duo_killer, 'save_auth'), \
                    patch.object(duo_killer, 'ensure_strong_login', return_value=False), \
                    patch.object(duo_killer, 'prepare_flow', return_value=object()), \
                    patch.object(duo_killer, 'add_to_bag',
                                 side_effect=lambda part, quantity=1, **k: added.append((part, quantity))
                                 or {'success': True}), \
                    patch.object(duo_killer, 'pay_bag', return_value={'success': True}), \
                    patch.object(duo_killer.requests, 'Session'):
                result = service.run('purchase', {'items': [{'sku': 'mk2u4ch', 'quantity': 2},
                                                            {'sku': 'mjta4ch', 'quantity': 1}]})
            self.assertTrue(result['success'])
            self.assertEqual(added, [('MK2U4CH/A', 2), ('MJTA4CH/A', 1)])

    def test_bag_action_survives_missing_amounts(self):
        from unittest.mock import Mock
        import duo_killer
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = Service(Mock(), root, root, 'a@example.test', Mock())

            class Flow:
                model = {'shoppingCart': {'items': {'item-1': {'d': {'name': '测试商品', 'sku': 'MK2U4CH/A', 'totalPrice': None},
                                                              'itemQuantity': {'d': {'quantity': 2}}}},
                                          'summary': {'d': {}}}}

                def page(self, *args, **kwargs):
                    return None

            with patch.object(duo_killer, 'authenticate'), \
                    patch.object(duo_killer, 'save_auth'), \
                    patch.object(duo_killer, 'Checkout', return_value=Flow()), \
                    patch.object(duo_killer.requests, 'Session'):
                result = service.run('bag', {})
            self.assertTrue(result['success'])
            self.assertEqual(result['total'], '')
            self.assertEqual(result['items'][0]['subtotal'], '')
            self.assertIn('官网未返回可识别的购物袋合计金额', result['message'])

    def test_preset_apply_action_reports_what_was_filled(self):
        from unittest.mock import Mock
        general = None
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            general = root / "settings" / "checkout.json"
            account_dir = root / "accounts" / "abc"
            account_dir.mkdir(parents=True)
            general.parent.mkdir(parents=True, exist_ok=True)
            import checkout_options
            checkout_options.save_config(general, {
                "contact": {"lastName": "测", "firstName": "试",
                            "emailAddress": "a@example.test", "fullDaytimePhone": "13800000000"},
                "delivery": {"state": "四川", "city": "成都", "district": "锦江区"},
                "address": {"street": "通用预设路 1 号"},
                "delivery_method": "delivery",
                "applecare": True,
            })
            service = Service(Mock(), account_dir, account_dir, 'a@example.test', Mock())
            result = service.run('preset_apply', {})
            self.assertTrue(result['success'])
            self.assertEqual(result['config']['address']['street'], "通用预设路 1 号")
            self.assertIn("地址", result['message'])
            self.assertIn("快递配送", result['message'])
            self.assertIn("AppleCare+", result['message'])

    def test_stores_action_returns_list(self):
        from unittest.mock import Mock
        import checkout_options
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = Service(Mock(), root, root, 'a@example.test', Mock())
            with patch.object(checkout_options, 'store_search',
                              return_value=[{'id': 'R1', 'name': '门店一'}]) as lookup:
                result = service.run('stores', {'state': '湖北', 'city': '武汉'})
            lookup.assert_called_once()
            self.assertEqual(result['stores'][0]['name'], '门店一')
            self.assertEqual(result['city'], '武汉')

    def test_windows_and_macos_browser_locations(self):
        win=browser_candidates('win32',{'PROGRAMFILES':'C:/Program Files','LOCALAPPDATA':'C:/Local'})
        self.assertTrue(any(str(p).endswith('chrome.exe') for p in win))
        self.assertTrue(any(str(p).endswith('msedge.exe') for p in win))
        self.assertTrue(any(str(p).endswith('Google Chrome') for p in browser_candidates('darwin')))
        linux=[str(p).replace('\\','/') for p in browser_candidates('linux',{})]
        self.assertTrue(any(p.endswith('google-chrome') or p.endswith('chromium') for p in linux))
        self.assertTrue(any(p.startswith('/opt/google/chrome') for p in linux))

    def test_confirmation_requires_a_true_boolean(self):
        from unittest.mock import Mock
        channel=Mock();channel.prompt.return_value=''
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);service=Service(channel,root,root,'fixture',Mock())
            model={'checkout':{'review':{'fulfillmentReview':{},'summary':{'d':{'total':'RMB 1'}}}}}
            with patch.object(duo_killer,'model_item_nodes',return_value=[{'d':{'name':'测试','sku':'TEST/A','totalPrice':'RMB 1'},'itemQuantity':{'d':{'quantity':1}}}]):
                with self.assertRaisesRegex(ValueError,'已取消'):duo_killer.confirm_order(model)
                # 全自动下单：不询问，直接继续（不抛异常）。
                channel.prompt.reset_mock()
                duo_killer.confirm_order(model, auto=True)
                channel.prompt.assert_not_called()


class ProcessIsolationTests(unittest.TestCase):
    def test_worker_protocol_uses_utf8_with_non_utf8_system_encoding(self):
        root = Path(__file__).resolve().parents[2] / 'worker'
        account_id, task_id = str(uuid.UUID(int=0)), str(uuid.uuid4())
        address = {
            'contact': {'lastName': '测', 'firstName': '试', 'emailAddress': 'fixture@example.test', 'fullDaytimePhone': '13800000000'},
            'delivery': {'state': '四川', 'city': '成都', 'district': '锦江区'},
            'address': {'street': '测试路 1 号'},
        }
        with tempfile.TemporaryDirectory() as directory:
            process = subprocess.Popen(
                [sys.executable, str(root / 'main.py'), '--data-dir', directory, '--account-id', account_id, '--task-id', task_id],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding='utf-8',
                env={**os.environ, 'PYTHONIOENCODING': 'cp1252', 'PYTHONUTF8': '0'},
            )
            try:
                request = dict(account_id=account_id, task_id=task_id, account='', action='address_save', params=address)
                process.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
                process.stdin.flush()
                event = json.loads(process.stdout.readline())
                self.assertEqual(event['type'], 'result', event)
                self.assertEqual(event['result']['config'], {**address, 'auto_checkout': True})
                self.assertEqual(event['result']['message'], '快捷地址已保存：四川 成都 锦江区 测试路 1 号。下单时直接使用，全程全自动。')
                self.assertEqual(process.wait(15), 0)
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(5)
                for pipe in (process.stdin, process.stdout, process.stderr):
                    pipe.close()

    def test_two_concurrent_workers_write_only_their_account(self):
        root=Path(__file__).resolve().parents[2]/'worker'
        with tempfile.TemporaryDirectory() as directory:
            processes=[];accounts=[]
            try:
                for index in range(2):
                    account_id,task_id=str(uuid.uuid4()),str(uuid.uuid4());accounts.append(account_id)
                    process=subprocess.Popen([sys.executable,str(root/'main.py'),'--data-dir',directory,'--account-id',account_id,'--task-id',task_id],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
                    data={'contact':{'lastName':f'测试{index}','firstName':'人','emailAddress':f'a{index}@example.test','fullDaytimePhone':'13800000000'},'delivery':{'state':'四川','city':'成都','district':'锦江'},'address':{'street':f'测试地址{index}'}}
                    process.stdin.write(json.dumps(dict(account_id=account_id,task_id=task_id,account=f'a{index}@example.test',action='address_save',params=data))+'\n');process.stdin.flush()
                    processes.append(process)
                for index,process in enumerate(processes):
                    event=json.loads(process.stdout.readline());self.assertEqual(event['type'],'result',event)
                    self.assertEqual(event['account_id'],accounts[index]);self.assertEqual(process.wait(15),0)
                    data=json.loads((Path(directory)/'accounts'/accounts[index]/'checkout.json').read_text())
                    self.assertEqual(data['address']['street'],f'测试地址{index}')
                self.assertFalse((Path(directory)/'auth.json').exists())
            finally:
                for process in processes:
                    if process.poll() is None:process.kill()
                    process.wait(5)
                    for pipe in (process.stdin,process.stdout,process.stderr):pipe.close()




class AccountRemovalTests(unittest.TestCase):
    def test_forget_mode_only_deletes_the_requested_vault_entry(self):
        import main
        account = str(uuid.uuid4())
        with patch.object(sys, 'argv', ['worker', '--forget-account', account]), patch('credentials.Vault') as vault:
            main.main()
            vault.return_value.delete.assert_called_once_with(account)

    def test_forget_mode_rejects_paths_and_local_scope(self):
        import main
        for account in ('../outside', str(uuid.UUID(int=0))):
            with patch.object(sys, 'argv', ['worker', '--forget-account', account]), patch('credentials.Vault') as vault, patch('sys.stderr', io.StringIO()):
                with self.assertRaises(SystemExit):
                    main.main()
                vault.assert_not_called()

    def test_vault_deletion_does_not_hide_a_remaining_password(self):
        from credentials import Vault
        from keyring.errors import PasswordDeleteError
        from unittest.mock import Mock
        vault = Vault.__new__(Vault)
        vault.backend = Mock()
        vault.backend.delete_password.side_effect = PasswordDeleteError('fixture failure')
        vault.backend.get_password.return_value = 'fixture-password'
        with self.assertRaises(PasswordDeleteError):
            vault.delete('fixture-id')
        vault.backend.get_password.return_value = None
        vault.delete('fixture-id')


if __name__ == '__main__':
    unittest.main()
