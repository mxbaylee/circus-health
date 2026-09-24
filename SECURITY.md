# Security policy

Circus Health is prerelease software. Security fixes are accepted for the current repository state; no released version is currently designated as supported.

## Report a vulnerability

Use GitHub's **Report a vulnerability** form in the repository Security tab to open a private security advisory. Include the affected commit, prerequisites, impact, and a minimal reproduction using fictional data. Do not include real health information, credentials, recovery phrases, OAuth tokens, or private archive contents.

If private advisory reporting is unavailable, open a public issue containing only a request for a private reporting channel. Do not disclose exploit details or sensitive output in that issue.

Please allow the maintainer time to reproduce and assess a report before public disclosure. Receipt, response, or remediation deadlines are not guaranteed.

## Scope and operating assumptions

The default deployment binds to loopback. Remote access, shared-host use, reverse proxies, TLS termination, provider retention, host security, browser extensions, backups, and recovery-kit handling are operator responsibilities. The configured model provider can receive plaintext selected from an unlocked profile. See the [implemented security model and risk register](docs/security.md) before deployment.

Security recommendations in that audit describe proposed work; they are not implemented controls unless the current code and tests show otherwise.
