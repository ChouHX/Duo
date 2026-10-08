"""Offline checks for importing and reusing server-issued device trust across logins."""
import base64
from contextlib import ExitStack, redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import requests
from urllib3.response import HTTPResponse
import alipay_qr
import interaction
import duo_killer
from apple_login import AppleStoreLogin, AUTH, stored_device_trust, password_key, srp
from service import Service, empty_auth, validate_import


ACCOUNT = 'device@example.test'
TOKEN = 'SYNTHETIC+TRUST==SRVX'
EXPIRES = int(time.time()) + 86400


def cookie(**overrides):
    return {'name': 'DESabcdef', 'value': TOKEN, 'domain': '.idmsa.apple.com.cn',
            'path': '/', 'expires': EXPIRES, **overrides}


class DeviceTrustTests(unittest.TestCase):
    def test_old_python_export_without_trust_account_keeps_device_trust(self):
        original = empty_auth(ACCOUNT)
        original['trust_cookies'] = [cookie(value='"' + TOKEN + '"')]
        imported = validate_import(original, ACCOUNT)
        self.assertEqual(imported['trust_account'], ACCOUNT)
        self.assertEqual(imported['trust_cookies'][0]['value'], TOKEN)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'auth.json'
            path.write_text(json.dumps(imported))
            with requests.Session() as session:
                client = AppleStoreLogin(auth_path=path, session=session)
                client.account = ACCOUNT
                client.restore_trust()
                self.assertEqual(session.cookies.get('DESabcdef'), TOKEN)

    def test_session_only_exports_recover_trust_but_explicit_revocation_wins(self):
        original = empty_auth(ACCOUNT)
        del original['trust_cookies']
        original['cookies']['expiry_unknown'] = [cookie()]
        self.assertEqual(validate_import(original, ACCOUNT)['trust_cookies'], [cookie()])
        original['trust_cookies'] = []
        cleared = validate_import(original, ACCOUNT)
        self.assertEqual(cleared['trust_cookies'], [])
        self.assertEqual(cleared['cookies']['expiry_unknown'], [])

    def test_other_account_expired_malformed_or_wrong_domain_trust_is_not_reused(self):
        data = empty_auth(ACCOUNT)
        data['trust_cookies'] = [cookie(expires=0), cookie(expires='bad'), cookie(value='bad;value'),
                                 cookie(domain='.apple.com.cn'), cookie(path='/other'),
                                 cookie(name='other'), None, cookie()]
        self.assertEqual(stored_device_trust(data, ACCOUNT), [cookie()])
        data['trust_account'] = 'other@example.test'
        data['cookies']['expiry_unknown'] = [cookie()]
        imported = validate_import(data, ACCOUNT)
        self.assertEqual(imported['trust_cookies'], [])
        self.assertEqual(imported['cookies']['expiry_unknown'], [])
        with tempfile.TemporaryDirectory() as directory, requests.Session() as session:
            path = Path(directory) / 'auth.json'
            path.write_text(json.dumps(data))
            session.cookies.set('DESabcdef', TOKEN, domain='.idmsa.apple.com.cn', path='/')
            client = AppleStoreLogin(auth_path=path, session=session)
            client.account = ACCOUNT
            client.restore_trust()
            self.assertEqual(len(session.cookies), 0)

    def test_new_worker_session_reuses_first_login_trust_without_another_code(self):
        for sms in (False, True):
            with self.subTest(sms=sms), ExitStack() as stack:
                root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
                for name in ('ROOT', 'AUTH_PATH', 'LOG_PATH', 'PAYMENT_ROOT'):
                    stack.enter_context(patch.object(duo_killer, name, getattr(duo_killer, name)))
                stack.enter_context(patch.object(alipay_qr, 'ROOT', alipay_qr.ROOT))
                stack.enter_context(patch.object(interaction, 'handler', None))
                stack.enter_context(redirect_stdout(io.StringIO()))
                # SRP proofs are still checked; only the remote server and browser are simulated.
                password, salt = 'fixture-password', b'0123456789abcdef'
                key = password_key(password, salt, 100, 's2k')
                n, g = srp.get_ng(srp.NG_2048, None, None)
                x = srp.gen_x(hashlib.sha256, salt, ACCOUNT, key)
                verifier = srp.long_to_bytes(pow(g, x, n))
                servers, statuses, paths = {}, [], []

                def respond(session, method, url, **kwargs):
                    path = url.removeprefix(AUTH)
                    paths.append(path)
                    result = requests.Response()
                    result.status_code, result.url = 200, url
                    result.request = session.prepare_request(requests.Request(method, url,
                        **{k: v for k, v in kwargs.items() if k in ('headers', 'json', 'params')}))
                    data, payload = {}, kwargs.get('json', {})
                    if path == '/federate':
                        data = {'federated': False}
                    elif path == '/signin/init':
                        server = srp.Verifier(ACCOUNT, salt, verifier, base64.b64decode(payload['a']), hash_alg=srp.SHA256)
                        servers[id(session)] = server
                        _, challenge = server.get_challenge()
                        data = {'salt': base64.b64encode(salt).decode(), 'b': base64.b64encode(challenge).decode(),
                                'iteration': 100, 'protocol': 's2k', 'c': 'fixture-challenge'}
                    elif path == '/signin/complete':
                        proof = servers[id(session)].verify_session(base64.b64decode(payload['m1']))
                        self.assertEqual(proof, base64.b64decode(payload['m2']))
                        trusted = f'DESabcdef="{TOKEN}"' in result.request.headers.get('Cookie', '')
                        result.status_code = 200 if trusted else 409
                        statuses.append(result.status_code)
                        data = {'authType': 'hsa2'}
                    elif path == '':
                        data = {'hasTrustedDevices': True, 'trustedPhoneNumbers': [{'id': 7}]}
                    elif path == '/verify/phone':
                        self.assertTrue(sms)
                    elif path.endswith('/securitycode'):
                        self.assertEqual(payload['securityCode']['code'], '012345')
                    elif path == '/2sv/trust':
                        result.status_code = 204
                        trust = requests.cookies.create_cookie(**cookie(), secure=True)
                        session.cookies.set_cookie(trust)
                        result.cookies.set_cookie(trust)
                        result.headers['Set-Cookie'] = f'DESabcdef="{TOKEN}"; Domain=idmsa.apple.com.cn; Path=/; Secure; Max-Age=86400'
                    else:
                        self.fail('Unexpected endpoint: ' + path)
                    result.raw = HTTPResponse(headers=result.headers)
                    result._content = json.dumps(data).encode() if result.status_code != 204 else b''
                    return result

                stack.enter_context(patch.object(requests.Session, 'request', respond))
                stack.enter_context(patch.object(AppleStoreLogin, 'bootstrap'))
                stack.enter_context(patch.object(AppleStoreLogin, 'initialize_browser_context', return_value=False))
                stack.enter_context(patch.object(AppleStoreLogin, 'finish_store_login'))
                prompts = []
                for attempt in range(2):
                    channel, vault = Mock(), Mock()
                    channel.account_id = 'fixture-account'
                    channel.prompt.return_value = '012345'
                    vault.get.return_value = password
                    service = Service(channel, root, root, ACCOUNT, vault)
                    self.assertTrue(service.run('login', {'sms': sms})['device_trust_saved'])
                    service.cleanup_credentials()
                    prompts.append(channel.prompt.call_count)
                    saved = json.loads(service.auth.read_text())
                    self.assertEqual(saved['trust_account'], ACCOUNT)
                    self.assertEqual(saved['trust_cookies'][0]['value'], TOKEN)
                    self.assertNotIn('password', saved)
                    self.assertNotIn('012345', service.auth.read_text())
                self.assertEqual(statuses, [409, 200])
                self.assertEqual(prompts, [1, 0])
                self.assertEqual(paths.count('/2sv/trust'), 1)
                self.assertEqual(paths.count('/verify/phone'), 1 if sms else 0)
                # The accepted trust remains saved even if a later operation fails offline.
                service.cleanup_credentials(requests.Timeout())
                self.assertEqual(json.loads(service.auth.read_text())['trust_cookies'][0]['value'], TOKEN)


if __name__ == '__main__':
    unittest.main()
