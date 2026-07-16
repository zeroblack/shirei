use std::sync::LazyLock;

use regex::Regex;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::error::{Error, Result};

const MASK: &str = "••••";

struct ScrubRule {
    pattern: &'static LazyLock<Regex>,
    replacement: &'static str,
}

static SK_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}").unwrap());
static GITHUB_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bgh[posur]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}").unwrap()
});
static AWS_ACCESS_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap());
static AUTHORIZATION_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(Authorization:\s*)([^\r\n\x22\x27,]+)").unwrap());
static BEARER_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})").unwrap());
static FLAG_SECRET_EQUALS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(--(?:password|token|api-key|secret)=)(\S+)").unwrap());
static FLAG_SECRET_SPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(--(?:password|token|api-key|secret)\s+)(\S+)").unwrap());
static KV_SECRET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(password|token|secret)=(\S+)").unwrap());
static HEX_BLOB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[0-9a-fA-F]{32,}\b").unwrap());
static BASE64_BLOB: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9+/]{32,}={0,2}").unwrap());

const RULES: &[ScrubRule] = &[
    ScrubRule {
        pattern: &SK_KEY,
        replacement: MASK,
    },
    ScrubRule {
        pattern: &GITHUB_TOKEN,
        replacement: MASK,
    },
    ScrubRule {
        pattern: &AWS_ACCESS_KEY,
        replacement: MASK,
    },
    ScrubRule {
        pattern: &AUTHORIZATION_HEADER,
        replacement: "${1}••••",
    },
    ScrubRule {
        pattern: &BEARER_TOKEN,
        replacement: "${1}••••",
    },
    ScrubRule {
        pattern: &FLAG_SECRET_EQUALS,
        replacement: "${1}••••",
    },
    ScrubRule {
        pattern: &FLAG_SECRET_SPACE,
        replacement: "${1}••••",
    },
    ScrubRule {
        pattern: &KV_SECRET,
        replacement: "${1}=••••",
    },
];

// A run of mixed-case-and-digit alnum this long reads as a token, not prose
// or a kebab/snake identifier (those break the run at "-"/"_", which neither
// charset here includes) — the cheapest entropy proxy that avoids a real
// Shannon-entropy calculation for a security path that only needs to be safe,
// not precise.
fn has_mixed_composition(candidate: &str) -> bool {
    let has_lower = candidate.bytes().any(|b| b.is_ascii_lowercase());
    let has_upper = candidate.bytes().any(|b| b.is_ascii_uppercase());
    let has_digit = candidate.bytes().any(|b| b.is_ascii_digit());
    has_lower && has_upper && has_digit
}

fn scrub_blobs(input: &str) -> String {
    let after_hex = HEX_BLOB.replace_all(input, MASK).into_owned();
    let mut out = String::with_capacity(after_hex.len());
    let mut last = 0;
    for m in BASE64_BLOB.find_iter(&after_hex) {
        if !has_mixed_composition(m.as_str()) {
            continue;
        }
        out.push_str(&after_hex[last..m.start()]);
        out.push_str(MASK);
        last = m.end();
    }
    out.push_str(&after_hex[last..]);
    out
}

/// Masks known secret shapes to `••••` before a payload can reach an OS
/// notification. Mandatory, not a toggle — even `payload_verbosity: full`
/// goes through this. Order matters: prefix/KV rules run before the blob scan
/// so an already-masked token never re-triggers the entropy heuristic.
pub fn scrub_secrets(input: &str) -> String {
    let mut out = input.to_string();
    for rule in RULES {
        out = rule
            .pattern
            .replace_all(&out, rule.replacement)
            .into_owned();
    }
    scrub_blobs(&out)
}

#[tauri::command]
pub fn notify_fire(app: AppHandle, title: String, body: String) -> Result<()> {
    let scrubbed = scrub_secrets(&body);
    app.notification()
        .builder()
        .title(title)
        .body(scrubbed)
        .show()
        .map_err(|e| Error::Os(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Built from parts at runtime so secret scanners never see a contiguous
    // provider-shaped literal and flag these fixtures as real credentials.
    fn secret_fixture(prefix: &str, body: &str) -> String {
        format!("{prefix}{body}")
    }

    #[test]
    fn masks_anthropic_style_api_key() {
        let key = secret_fixture("sk-ant-api03-", "abcdEFGH12345678xyz");
        let out = scrub_secrets(&format!("export ANTHROPIC_API_KEY={key}"));
        assert!(!out.contains(&key));
        assert!(out.contains(MASK));
    }

    #[test]
    fn masks_openai_style_api_key() {
        let key = secret_fixture("sk-proj-", "abcdefghijklmnopqrst");
        let out = scrub_secrets(&format!("curl -H 'Authorization: Bearer {key}'"));
        assert!(!out.contains(&key));
    }

    #[test]
    fn masks_github_personal_access_token() {
        let tok = secret_fixture("ghp_", "1234567890abcdefghijklmnopqrstuvwx");
        let out = scrub_secrets(&format!(
            "git remote set-url origin https://{tok}@github.com/x/y"
        ));
        assert!(!out.contains(&tok));
        assert!(out.contains(MASK));
    }

    #[test]
    fn masks_github_oauth_token_prefix() {
        let tok = secret_fixture("gho_", "1234567890abcdefghijklmnopqrstuvwx");
        let out = scrub_secrets(&format!("token: {tok}"));
        assert!(!out.contains(&tok));
    }

    #[test]
    fn masks_github_fine_grained_pat() {
        let tok = secret_fixture("github_pat_", "11ABCDEFG0abcdefghijklmnopqrstuvwxyz");
        let out = scrub_secrets(&format!("export GH_TOKEN={tok}"));
        assert!(!out.contains(&tok));
    }

    #[test]
    fn masks_aws_access_key_id() {
        let out = scrub_secrets("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE deploying now");
        assert!(!out.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(out.contains(MASK));
    }

    #[test]
    fn masks_bearer_token_standalone() {
        let out =
            scrub_secrets("curl -H \"Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig\" api.example.com");
        assert!(!out.contains("eyJhbGciOiJIUzI1NiJ9.payload.sig"));
        assert!(out.contains("Bearer"));
        assert!(out.contains(MASK));
    }

    #[test]
    fn masks_authorization_header_value() {
        let out = scrub_secrets("Authorization: Bearer abcDEF123456789012345\nContent-Type: json");
        assert!(!out.contains("abcDEF123456789012345"));
        assert!(out.contains("Authorization:"));
        assert!(out.contains("Content-Type: json"));
    }

    #[test]
    fn masks_password_flag_with_equals() {
        let out = scrub_secrets("mysql -u root --password=hunter2secret");
        assert_eq!(out, format!("mysql -u root --password={MASK}"));
    }

    #[test]
    fn masks_token_flag_with_equals() {
        let out = scrub_secrets("gh auth login --token=abc123XYZsecretvalue");
        assert!(!out.contains("abc123XYZsecretvalue"));
    }

    #[test]
    fn masks_api_key_flag_with_equals() {
        let key = secret_fixture("sk_live_", "abcdefghijklmnop");
        let out = scrub_secrets(&format!("stripe-cli --api-key={key}"));
        assert!(!out.contains(&key));
    }

    #[test]
    fn masks_password_flag_space_separated() {
        let out = scrub_secrets("psql --password mySecretPass123");
        assert!(!out.contains("mySecretPass123"));
        assert!(out.contains("--password"));
    }

    #[test]
    fn masks_token_flag_space_separated() {
        let out = scrub_secrets("aws configure set --token abcDEF456ghijkl");
        assert!(!out.contains("abcDEF456ghijkl"));
    }

    #[test]
    fn masks_generic_password_kv_pair() {
        let out = scrub_secrets("DB_URL=postgres://user:pass@host password=Sup3rSecret db=prod");
        assert!(!out.contains("Sup3rSecret"));
        assert!(out.contains("password=") && out.contains(MASK));
    }

    #[test]
    fn masks_generic_token_kv_pair() {
        let out = scrub_secrets("query string: token=abcXYZ987654321 redirect=/home");
        assert!(!out.contains("abcXYZ987654321"));
        assert!(out.contains("redirect=/home"));
    }

    #[test]
    fn masks_generic_secret_kv_pair() {
        let secret = secret_fixture("whsec_", "abcdefghijklmnopqrstuvwx");
        let out = scrub_secrets(&format!("webhook secret={secret}"));
        assert!(!out.contains(&secret));
    }

    #[test]
    fn masks_long_hex_blob() {
        let out = scrub_secrets("checksum a3f5c9d1e2b4f6a8c0d2e4f6a8b0c2d4e6f8a0b2 verified");
        assert!(!out.contains("a3f5c9d1e2b4f6a8c0d2e4f6a8b0c2d4e6f8a0b2"));
        assert!(out.contains("verified"));
    }

    #[test]
    fn masks_high_entropy_base64_blob() {
        let out = scrub_secrets("payload: aGVsbG9Xb3JsZDEyMzQ1Njc4OUFCQ0RFRmdoaWprbG1ub3A=");
        assert!(!out.contains("aGVsbG9Xb3JsZDEyMzQ1Njc4OUFCQ0RFRmdoaWprbG1ub3A="));
    }

    #[test]
    fn negative_normal_command_untouched() {
        let out = scrub_secrets("git push --force-with-lease");
        assert_eq!(out, "git push --force-with-lease");
    }

    #[test]
    fn negative_file_path_untouched() {
        let path = "/Users/dioni/Project/shirei/app/src-tauri/src/notify.rs";
        assert_eq!(scrub_secrets(path), path);
    }

    #[test]
    fn negative_short_git_sha_untouched() {
        let out = scrub_secrets("fixed in a1b2c3d, see also 9f8e7d6");
        assert_eq!(out, "fixed in a1b2c3d, see also 9f8e7d6");
    }

    #[test]
    fn negative_plain_prose_untouched() {
        let out = scrub_secrets("the tests are passing and the build is green");
        assert_eq!(out, "the tests are passing and the build is green");
    }

    #[test]
    fn negative_lowercase_only_long_word_run_untouched() {
        let out = scrub_secrets("thisisaveryveryverylongwordwithoutanyseparatorsatall");
        assert_eq!(out, "thisisaveryveryverylongwordwithoutanyseparatorsatall");
    }

    #[test]
    fn negative_typical_tsc_error_untouched() {
        let out = scrub_secrets("tsc: 4 type errors in queue.ts");
        assert_eq!(out, "tsc: 4 type errors in queue.ts");
    }

    #[test]
    fn negative_diff_stat_untouched() {
        let out = scrub_secrets("6 files, +214 -38 · 2m14s");
        assert_eq!(out, "6 files, +214 -38 · 2m14s");
    }

    #[test]
    fn masks_multiple_secrets_in_one_payload() {
        let key = secret_fixture("sk-ant-", "abcdefghijklmnop123");
        let out = scrub_secrets(&format!(
            "curl -H \"Authorization: Bearer {key}\" --password=lookout9"
        ));
        assert!(!out.contains(&key));
        assert!(!out.contains("lookout9"));
    }
}
