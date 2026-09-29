# Source notices

Pi Remote WeCom is distributed under the [MIT License](LICENSE), copyright 2026 Luke.

## Included source

- The session engine and terminal adapters were adapted from `pi-remote`, revision `5e0d17b9ad541a822d02b3feeded7d1cc7f50a7f`, also copyright 2026 Luke under MIT. The original license is retained by this project's root license.
- `vendor/tab-title/` derives from the `pi-tab-title` snapshot at revision `379e1c22eeb31cd3705fc9f464e1776702a0e76f`, with subsequent naming-policy and lifecycle changes. Its [MIT license](vendor/tab-title/LICENSE) is included separately. The snapshot identifiers document provenance; no public upstream URL is asserted for these personal projects.

## Dependencies

The WeCom transport uses the official [@wecom/aibot-node-sdk](https://github.com/WecomTeam/aibot-node-sdk), installed as a dependency. Pi host modules are declared as peer dependencies and are supplied by Pi. Dependency packages retain their own licenses; see their installed package contents and the lockfile metadata.
