# SignPath Code Signing Setup

Brows3 uses [SignPath Foundation](https://signpath.org/) for free Windows Authenticode code signing. This eliminates SmartScreen "Unknown Publisher" warnings for end users.

## Prerequisites

- SignPath Foundation approval (free for open-source projects)
- GitHub repository with Actions enabled

## Step 1: Apply for SignPath Foundation

1. Go to https://signpath.io/solutions/open-source-community
2. Click "Apply for free"
3. Fill out the application with your GitHub repo URL
4. Wait for approval (typically 1-3 business days)

## Step 2: Configure SignPath Project

After approval:

1. Create a **Project** in SignPath dashboard:
   - Project slug: `brows3`
   - Link to GitHub repository: `https://github.com/junbujianwpl/brows3`
   - Trusted build system: GitHub

2. Create an **Artifact Configuration**:
   - Slug: `windows`
   - Upload or paste from `.signpath/artifact-configuration-exe.xml`

3. Create a **Signing Policy**:
   - Slug: `release-signing`
   - Origin verification: enabled
   - Allowed branches: `main`, `refs/tags/app-v*`

4. Install the **SignPath GitHub App** on the repository

## Step 3: Add GitHub Secrets

In your GitHub repository: **Settings → Secrets and variables → Actions**

Add these two secrets:

| Secret Name | Value | Where to Find |
|-------------|-------|---------------|
| `SIGNPATH_API_TOKEN` | API token string | SignPath dashboard → User menu → API Tokens |
| `SIGNPATH_ORG_ID` | Organization UUID | SignPath dashboard → Organization name (top-right corner) |

That's it. The next release build will automatically sign Windows binaries.

## How It Works

The release workflow (`.github/workflows/release.yml`) does:

1. **Build** — Compiles Windows exe/msi as before
2. **Upload** — Stores unsigned binaries as GitHub Actions artifacts
3. **Sign** — `sign-windows` job submits artifacts to SignPath via API
4. **Wait** — SignPath verifies the build came from the repo, then signs
5. **Release** — Signed binaries are uploaded to the GitHub Release

If SignPath secrets are not configured, the workflow falls back to uploading unsigned binaries (existing behavior).

## File Layout

```
.signpath/
├── artifact-configuration.xml      # For MSI (includes embedded DLLs)
└── artifact-configuration-exe.xml  # For standalone exe (NSIS installer)
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| SignPath rejects signing request | Check branch restrictions in signing policy |
| "Artifact not found" error | Ensure `upload-artifact` step name matches |
| SmartScreen still warns after signing | Normal for new certificates — reputation builds over 1-2 weeks of downloads |
| Build passes but signing is skipped | Verify `SIGNPATH_API_TOKEN` and `SIGNPATH_ORG_ID` secrets are set |

## Notes

- The certificate is issued to "SignPath Foundation" and links to your repository
- SmartScreen reputation takes time to build (1-2 weeks of user downloads)
- SignPath logs all signing requests for audit/transparency
- The `.signpath/` directory must be committed to the repository
