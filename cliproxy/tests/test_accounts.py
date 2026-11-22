import importlib.util
import json
import pathlib
import tempfile
import unittest

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('accounts', PACKAGE / 'scripts/accounts.py')
accounts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounts)


class AccountRouting(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.auths = pathlib.Path(self.temp.name)

    def credential(self, name, **fields):
        (self.auths / name).write_text(json.dumps({'access_token': 'secret', **fields}))

    def test_prefix_is_derived_from_the_credential_itself(self):
        self.assertEqual(accounts.prefix('codex', 'a@example.com'), 'codex-a@example.com')
        self.assertIsNone(accounts.prefix('xai', 'a@example.com'))
        self.assertIsNone(accounts.prefix('claude', None))
        self.assertIsNone(accounts.prefix('claude', 'a/b@example.com'))

    def test_only_routed_credentials_without_their_prefix_are_pending(self):
        self.credential('claude-1.json', type='claude', email='a@example.com')
        self.credential('claude-2.json', type='claude', email='b@example.com', prefix='claude-b@example.com')
        self.credential('codex-1.json', type='codex', email='a@example.com', prefix='other')
        self.credential('xai-1.json', type='xai', email='a@example.com')
        self.credential('meta-1.json', type='meta')
        (self.auths / 'broken.json').write_text('{')
        self.assertEqual(accounts.pending(self.auths),
                         [('claude-1.json', 'claude-a@example.com'), ('codex-1.json', 'codex-a@example.com')])

    def test_no_account_is_named_in_tracked_source(self):
        self.assertFalse((PACKAGE / 'accounts.json').exists())


NOW = 1_800_000_000  # 2027-01-15T08:00:00Z


class AccountState(unittest.TestCase):
    """Synthetic credentials and management entries only."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.auths = pathlib.Path(self.temp.name) / 'auths'
        self.auths.mkdir()

    def credential(self, name, **fields):
        (self.auths / name).write_text(json.dumps({'access_token': 'secret', 'refresh_token': 'r-' + name, **fields}))

    def states(self, entries):
        return [(a['provider'], a['index'], a['state'], a['until'])
                for a in accounts.roster(self.auths, entries, now=NOW)]

    def test_every_account_of_a_provider_in_cooldown_says_when_it_clears(self):
        self.credential('claude-a.json', type='claude', email='a@example.com')
        self.credential('claude-b.json', type='claude', email='b@example.com')
        self.assertEqual(self.states([
            {'name': 'claude-a.json', 'unavailable': True, 'next_retry_after': '2027-01-15T09:00:00Z'},
            {'name': 'claude-b.json', 'quota': {'exceeded': True, 'next_recover_at': NOW + 1800}},
        ]), [('claude', 1, 'cooling-down', '2027-01-15T09:00:00Z'),
             ('claude', 2, 'cooling-down', '2027-01-15T08:30:00Z')])

    def cooldowns(self, entries):
        return [a['cooldowns'] for a in accounts.roster(self.auths, entries, now=NOW)]

    def test_a_model_in_cooldown_is_listed_and_leaves_the_account_usable(self):
        # The pinned proxy lists an unexpired retry restriction per credential
        # (`cooldowns`), by scope: one model, or the whole credential.
        self.credential('antigravity-a.json', type='antigravity', email='a@example.com')
        entries = [{'name': 'antigravity-a.json', 'unavailable': False, 'cooldowns': [
            {'scope': 'model', 'model_key': 'gemini-3.8-flash-high', 'reason': 'quota',
             'retry_at': '2027-01-15T09:00:00Z', 'remaining_seconds': 3600, 'http_status': 429},
            {'scope': 'model', 'model_key': 'gemini-3.8-pro', 'reason': 'quota', 'retry_at': '2027-01-15T07:00:00Z'},
        ]}]
        self.assertEqual(self.states(entries), [('antigravity', 1, 'usable', None)])
        self.assertEqual(self.cooldowns(entries), [[
            {'model': 'gemini-3.8-flash-high', 'reason': 'quota', 'until': '2027-01-15T09:00:00Z'},
        ]])

    def test_a_cooldown_of_the_whole_credential_cools_the_account_down(self):
        self.credential('codex-a.json', type='codex', email='a@example.com')
        entries = [{'name': 'codex-a.json', 'cooldowns': [
            {'scope': 'credential', 'reason': 'credential_quota', 'retry_at': '2027-01-15T10:00:00Z'},
        ]}]
        self.assertEqual(self.states(entries), [('codex', 1, 'cooling-down', '2027-01-15T10:00:00Z')])
        self.assertEqual(self.cooldowns(entries), [[]])

    def test_a_cooldown_reports_a_known_reason_and_never_what_a_provider_said(self):
        self.credential('claude-a.json', type='claude', email='a@example.com')
        entries = [{'name': 'claude-a.json', 'cooldowns': [
            {'scope': 'model', 'model_key': 'claude-sonnet-5-5', 'reason': 'private upstream body',
             'retry_at': '2027-01-15T09:00:00Z'},
            {'scope': 'model', 'model_key': 'claude-a@example.com/claude-opus-5-5', 'reason': 'quota',
             'retry_at': '2027-01-15T09:00:00Z'},
        ]}]
        self.assertEqual(self.cooldowns(entries), [[
            {'model': 'claude-sonnet-5-5', 'reason': 'unknown', 'until': '2027-01-15T09:00:00Z'},
        ]])

    def test_a_proxy_that_does_not_say_lists_no_cooldown(self):
        self.credential('claude-a.json', type='claude', email='a@example.com')
        self.assertEqual(self.cooldowns([{'name': 'claude-a.json', 'cooldowns': None}]), [[]])
        self.assertEqual(self.cooldowns([]), [[]])

    def test_a_rejected_refresh_token_needs_a_login_for_that_account_only(self):
        self.credential('codex-a.json', type='codex', email='a@example.com')
        self.credential('codex-b.json', type='codex', email='b@example.com')
        self.assertEqual(self.states([
            {'name': 'codex-a.json', 'status': 'error', 'status_message': 'refresh failed: invalid_grant'},
            {'name': 'codex-b.json', 'status': 'active'},
        ]), [('codex', 1, 'needs-login', None), ('codex', 2, 'usable', None)])

    def test_a_refresh_that_fails_for_now_is_not_a_lost_login(self):
        self.credential('claude-a.json', type='claude', email='a@example.com', expired='2027-02-01T00:00:00Z')
        self.credential('claude-b.json', type='claude', email='b@example.com', expired='2026-01-01T00:00:00Z')
        failing = {'status': 'error', 'status_message': 'refresh request timed out'}
        self.assertEqual(self.states([{'name': 'claude-a.json', **failing}, {'name': 'claude-b.json', **failing}]),
                         [('claude', 1, 'refresh-failing', None), ('claude', 2, 'needs-login', None)])

    def test_a_disabled_credential_is_removed(self):
        self.credential('xai-1.json', type='xai')
        self.assertEqual(self.states([{'name': 'xai-1.json', 'disabled': True}]), [('xai', 1, 'removed', None)])

    def test_the_roster_version_follows_the_accounts_and_nothing_else(self):
        self.credential('claude-a.json', type='claude', email='a@example.com')
        first = accounts.version(accounts.roster(self.auths, now=NOW))
        cooling = accounts.version(accounts.roster(self.auths, [{'name': 'claude-a.json', 'unavailable': True}], now=NOW))
        self.credential('claude-b.json', type='claude', email='b@example.com')
        added = accounts.version(accounts.roster(self.auths, now=NOW))
        self.assertEqual(first, cooling)
        self.assertNotEqual(first, added)
        # Every node computes the same digest from the proxy's model list.
        # features/accounts/roster.feature asserts the same value.
        self.assertEqual(added, 'ff95b2561c9dab07')

    def test_the_reported_roster_names_no_file_and_no_token(self):
        self.credential('claude-a.json', type='claude', email='a@example.com')
        text = json.dumps(accounts.public(accounts.roster(self.auths, now=NOW)))
        self.assertNotIn('claude-a.json', text)
        self.assertNotIn('secret', text)


class AccountLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.auths = pathlib.Path(self.temp.name) / 'auths'
        self.auths.mkdir()

    def test_an_interrupted_login_leaves_no_half_written_credential(self):
        stage = accounts.begin(self.auths)
        (stage / 'claude-new.json').write_text('{"type": "claude", "access_tok')
        self.assertEqual(accounts.adopt(stage, self.auths), [])
        self.assertEqual(list(self.auths.iterdir()), [])
        self.assertFalse(stage.exists())

    def test_leftovers_of_an_interrupted_login_are_discarded_by_the_next(self):
        stage = accounts.begin(self.auths)
        (stage / 'partial.json').write_text('{')
        stage = accounts.begin(self.auths)
        self.assertEqual(list(stage.iterdir()), [])

    def test_a_complete_login_is_moved_in(self):
        stage = accounts.begin(self.auths)
        (stage / 'codex-a.json').write_text(json.dumps({'type': 'codex', 'email': 'a@example.com'}))
        self.assertEqual(accounts.adopt(stage, self.auths), ['codex-a.json'])
        self.assertEqual(accounts.roster(self.auths)[0]['provider'], 'codex')

    def test_a_relogin_replaces_exactly_that_account(self):
        (self.auths / 'claude-a.json').write_text(json.dumps({'type': 'claude', 'email': 'a@example.com', 'refresh_token': 'old'}))
        (self.auths / 'claude-b.json').write_text(json.dumps({'type': 'claude', 'email': 'b@example.com', 'refresh_token': 'b'}))
        stage = accounts.begin(self.auths)
        (stage / 'claude-x.json').write_text(json.dumps({'type': 'claude', 'email': 'a@example.com', 'refresh_token': 'new'}))
        target = accounts.find(accounts.roster(self.auths), 'claude', 1)['file']
        accounts.adopt(stage, self.auths, replace=target)
        self.assertEqual(sorted(p.name for p in self.auths.iterdir()), ['claude-a.json', 'claude-b.json'])
        self.assertEqual(json.loads((self.auths / 'claude-a.json').read_text())['refresh_token'], 'new')
        self.assertEqual(json.loads((self.auths / 'claude-b.json').read_text())['refresh_token'], 'b')

    def test_removal_deletes_one_credential(self):
        (self.auths / 'codex-a.json').write_text(json.dumps({'type': 'codex', 'email': 'a@example.com'}))
        (self.auths / 'codex-b.json').write_text(json.dumps({'type': 'codex', 'email': 'b@example.com'}))
        self.assertEqual(accounts.remove(self.auths, 'codex', 2), 'codex-b.json')
        self.assertEqual([p.name for p in self.auths.iterdir()], ['codex-a.json'])
        with self.assertRaises(ValueError):
            accounts.remove(self.auths, 'codex', 5)
