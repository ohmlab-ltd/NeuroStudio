# Releasing Neuro Studio

The release workflow, `.github/workflows/release.yml`, builds the installers on
Windows, macOS and Linux. Before attaching them to the release it runs the
unit tests and installs and runs each installer against a fake board
(`scripts/smoke.mjs`), so a build that does not install or start is never
published.

| File | Built on | What it is |
| --- | --- | --- |
| `Neuro-Studio-Setup.exe` | Windows | Installer, per user, with Start menu and desktop shortcuts |
| `Neuro-Studio-Portable.exe` | Windows | The app, run without installing |
| `Neuro-Studio.dmg` | macOS | One app for Apple Silicon and Intel |
| `neuro-studio_amd64.deb` | Linux | For Ubuntu and Debian; installs the board's udev rule |
| `Neuro-Studio-x86_64.AppImage` | Linux | For other distributions |

The file names carry no version, so
`https://github.com/<owner>/<repo>/releases/latest/download/<file>` always
fetches the latest release. The README's Download links rely on this.

## Making a release

1. Set `version` in `package.json`.
2. Rename the `## Unreleased` section of `CHANGELOG.md` to `## X.Y.Z`. It
   becomes the release notes, followed by GitHub's generated notes.
3. Check that `repository` in `package.json` names the repository you release
   from. The app's update check looks for new releases there.
4. Push a `vX.Y.Z` tag.

The workflow's first job fails, before anything is built, when the tag,
`package.json` and `CHANGELOG.md` disagree or `package.json` names another
repository. To check locally:

```bash
node scripts/check-release.mjs vX.Y.Z <owner>/<repo>
```

To build and test the installers without releasing, run the release workflow
from the Actions tab (Run workflow). The installers are kept as the run's
artifacts.

Each binary release corresponds to the source at its tag, as the GPL
requires.

## Signing

Unsigned, the installers work, but Windows SmartScreen and macOS Gatekeeper
warn on first launch, and the README says how to get past the warnings.
Signing removes the warnings. Each kind of signing turns on when its secrets
are set in the repository (Settings, Secrets and variables, Actions); the
workflow and `electron-builder.cjs` need no change. After signing is set up,
remove the warning paragraph from the README's Download section.

### macOS: Developer ID and notarization

1. Join the Apple Developer Program as Ohm Lab Ltd. It costs US$99 a year, and
   enrolling an organisation needs its D-U-N-S number.
2. In Certificates, Identifiers & Profiles, create a **Developer ID
   Application** certificate. Export it from Keychain Access as a `.p12` file
   with a password.
3. Create an app-specific password for the Apple ID at
   [account.apple.com](https://account.apple.com), and note the Team ID in the
   developer account's Membership details.
4. Set these secrets:

   | Secret | Value |
   | --- | --- |
   | `MAC_CSC_LINK` | the `.p12` file, base64-encoded on one line (`base64 -i cert.p12`) |
   | `MAC_CSC_KEY_PASSWORD` | the `.p12` password |
   | `APPLE_ID` | the Apple ID's email address |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
   | `APPLE_TEAM_ID` | the Team ID |

With the certificate, the app is signed with the hardened runtime instead of
ad hoc, and with the three Apple secrets it is notarized. Set all five
together: notarizing an ad-hoc build fails. The smoke test's log reports
whether Gatekeeper accepts the app.

### Windows: Azure Artifact Signing

Microsoft's Artifact Signing service (Trusted Signing until 2026) signs
without a hardware token. Its Basic plan costs about $10 a month for 5,000
signatures. Organisations in the USA, Canada, the EU and the UK can use it, and
Microsoft validates the organisation's identity before issuing anything, which
takes from a few days to a few weeks. Azure's role names may still say Trusted
Signing.

1. In the Azure portal, under the subscription's **Resource providers**,
   register `Microsoft.CodeSigning`.
2. Create an Artifact Signing account on the Basic plan, in a region near you.
   Its overview shows the endpoint, such as `https://weu.codesigning.azure.net/`
   for West Europe.
3. On the account, give yourself the **Identity Verifier** role, then under
   **Identity validation** request a Public Trust validation for the
   organisation, with its legal name exactly as registered: for a UK company,
   as at Companies House.
4. Once the validation has completed, create a **Public Trust** certificate
   profile on it.
5. Register an app in Microsoft Entra ID, create a client secret for it, and
   give it the **Certificate Profile Signer** role on the profile.
6. In the repository's **Settings**, **Secrets and variables**, **Actions**, set
   these **variables**:

   | Variable | Value |
   | --- | --- |
   | `AZURE_SIGN_ENDPOINT` | the account's endpoint, such as `https://weu.codesigning.azure.net/` |
   | `AZURE_SIGN_ACCOUNT` | the Artifact Signing account name |
   | `AZURE_SIGN_PROFILE` | the certificate profile name |
   | `AZURE_SIGN_PUBLISHER` | the certificate's subject name, such as `Ohm Lab Ltd` |

   and these **secrets**: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
   `AZURE_CLIENT_SECRET`, from the app registration.

A certificate that can be exported to a `.pfx` file works instead: set
`WIN_CSC_LINK` to the file, base64-encoded, and `WIN_CSC_KEY_PASSWORD` to its
password. Most code-signing certificates issued since 2023 live on a hardware
token or in a cloud service and cannot be exported this way.

Even signed, SmartScreen can warn about a new certificate until enough people
have downloaded files signed with it.

## Packaging locally

`npm run package` builds the installers for the computer's own platform into
`release/`, with the same configuration as the workflow (`electron-builder.cjs`).
`npm run smoke -- --install` installs one and runs it against a fake board.
On Windows it refuses to run when Neuro Studio is already installed for the
user, as installing would replace that copy.
