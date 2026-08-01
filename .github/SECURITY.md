# TubeBoard Website And Service Security Policy

Use this repository's **Security → Report a vulnerability** flow for a private
report, or contact the repository owner through an already-established private
channel. Never place APNs/Fly/TfL credentials, registration tokens, personal
data, production records, or complete exploit details in a public Issue, PR,
Actions log, screenshot, or AI prompt.

Include the affected endpoint or component, safe reproduction steps, likely
impact, and version or source revision. The canonical response process and
central project tracking contract live in
`olly-j/My-Train-Times/.github/SECURITY.md`. Remediation uses a central
`TB-NNN`; sensitive evidence remains private. Rotate exposed credentials first,
preserve the Fly volume, and treat merged source, deployment, and public app
release as separate states.

Dependency vulnerability alerts, secret scanning, push protection, and private
vulnerability reporting are enabled. Routine automated dependency-update and
security-fix PRs remain disabled pending compatibility and impact review.
