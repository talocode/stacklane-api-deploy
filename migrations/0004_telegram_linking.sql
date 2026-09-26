-- Linking a dashboard account to a Telegram identity, mirroring the wallet flow.
--
-- The wallet flow proves control of an external identity before anything is
-- attached to the account: the dashboard issues a nonce, the client signs it,
-- the API verifies the signature and records the link. Telegram has no
-- signature to check, so the proof is instead possession of a short code that
-- only the dashboard could have issued and only the bot can redeem. The bot
-- authenticates with a shared secret, so the API never trusts a caller's claim
-- about which Telegram account is speaking.
--
-- Deliberately account level, not project level. A Telegram identity belongs to
-- the person, not to one project, so nothing here references cloud_projects.

CREATE TABLE IF NOT EXISTS stacklane.telegram_challenges (
    code         TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES stacklane.users(id) ON DELETE CASCADE,
    purpose      TEXT NOT NULL DEFAULT 'link',
    telegram_id  TEXT,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT telegram_challenges_purpose_check CHECK (purpose IN ('link', 'login'))
);

CREATE INDEX IF NOT EXISTS telegram_challenges_user_id_idx ON stacklane.telegram_challenges(user_id);
CREATE INDEX IF NOT EXISTS telegram_challenges_expires_at_idx ON stacklane.telegram_challenges(expires_at);

-- One Telegram account maps to one dashboard user, and one dashboard user has at
-- most one Telegram account. Both directions are unique, so a re-link has to
-- replace rather than accumulate.
CREATE TABLE IF NOT EXISTS stacklane.telegram_links (
    telegram_id   TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL UNIQUE REFERENCES stacklane.users(id) ON DELETE CASCADE,
    username      TEXT,
    first_name    TEXT,
    linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS telegram_links_user_id_idx ON stacklane.telegram_links(user_id);

-- Expired and consumed codes are noise once they are a day old. Kept short so
-- the table does not become an incidental log of who tried to link when.
CREATE OR REPLACE FUNCTION stacklane.prune_telegram_challenges() RETURNS void AS $$
BEGIN
    DELETE FROM stacklane.telegram_challenges
     WHERE expires_at < now() - interval '1 day'
        OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 day');
END;
$$ LANGUAGE plpgsql;
