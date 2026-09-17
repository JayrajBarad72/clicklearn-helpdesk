# ClickLearn Helpdesk — Deployment Runbook

This turns the project into a live site at **helpdesk.clicklearn.com** where a signed-in
ClickLearn employee submits a request and a **Task** is created on your Azure DevOps board.

Architecture: **Azure Static Web Apps** (hosts the frontend + the API) → the API calls the
**Azure DevOps REST API** to create the Task. Sign-in is handled by **Microsoft Entra ID**.

You do the steps below in **your** Azure / Azure DevOps tenant. Nothing here asks anyone to
share a password or token with a third party — every secret is created by you and stored in
Azure's own secret settings.

---

## What you need before starting
- Access to your Azure subscription (you confirmed you have this).
- Owner/PM rights on the Azure DevOps project so you can create a PAT.
- A GitHub (or Azure DevOps) repo to hold this code — Static Web Apps deploys from it.
- Rights to add a DNS record for `helpdesk.clicklearn.com`.

---

## Step 1 — Put this code in a repo
1. Create a new repo (GitHub is easiest with Static Web Apps).
2. Copy the contents of the `clicklearn-helpdesk/` folder into it, keeping this layout:
   ```
   /frontend            → index.html (login), request.html (wizard)
   /api                 → the Azure Function that creates the Task
   staticwebapp.config.json
   ```
3. Commit and push.

## Step 2 — Generate the Azure DevOps PAT (you create this — keep it secret)
1. In Azure DevOps: click your avatar → **Personal access tokens** → **New Token**.
2. Name: `helpdesk-portal`. Organization: your org. Expiry: your policy (e.g. 90 days).
3. Scopes: **Work Items → Read, write, & manage**. (That's all it needs.)
4. **Create**, then **copy the token now** — you won't see it again.
   You'll paste it into an Azure secret in Step 4. Do not commit it to the repo.

## Step 3 — Create the Static Web App
1. Azure Portal → **Create resource** → **Static Web App**.
2. Subscription/Resource group: your choice. Name: `clicklearn-helpdesk`.
3. Plan type: **Standard** (needed for custom auth + custom domain).
4. Deployment: connect the repo from Step 1. Build details:
   - **App location:** `/frontend`
   - **Api location:** `/api`
   - **Output location:** *(leave blank)*
5. Create. Azure adds a deploy workflow to your repo and does the first build.

## Step 4 — Add the app settings (secrets)
In the Static Web App → **Settings → Environment variables** (Application settings), add:

| Name               | Value                                             |
|--------------------|---------------------------------------------------|
| `ADO_ORG`          | your DevOps org name (from `dev.azure.com/<org>`)  |
| `ADO_PROJECT`      | your DevOps project name                           |
| `ADO_PAT`          | the token from Step 2                              |
| `TEAM_LEAD_EMAIL`  | *(optional)* the Team Lead's UPN, to auto-assign for triage |

> Leave `TEAM_LEAD_EMAIL` empty if you'd rather new tasks land unassigned in the backlog.

## Step 5 — Turn on Entra ID sign-in (employees only)
1. In **Entra ID → App registrations → New registration**:
   - Name: `ClickLearn Helpdesk`
   - Supported account types: **Accounts in this organizational directory only** (this is what
     restricts access to ClickLearn employees).
   - Redirect URI (Web): `https://<your-swa-name>.azurestaticapps.net/.auth/login/aad/callback`
2. Copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. Under **Certificates & secrets → New client secret**, create one and copy its value.
4. Back in the Static Web App → **Environment variables**, add:
   - `AAD_CLIENT_ID` = the Application (client) ID
   - `AAD_CLIENT_SECRET` = the client secret value
5. In `staticwebapp.config.json`, replace `<YOUR_TENANT_ID>` with your Directory (tenant) ID,
   commit, and let it redeploy.

## Step 6 — Point the domain
1. Static Web App → **Custom domains → Add** → `helpdesk.clicklearn.com`.
2. Add the CNAME record Azure shows you at your DNS provider.
3. Once validated, add the same URL as a redirect URI on the app registration from Step 5
   (`https://helpdesk.clicklearn.com/.auth/login/aad/callback`).

---

## Test it
1. Open `https://helpdesk.clicklearn.com` → you should see the sign-in page.
2. Click **Sign in with Microsoft** → sign in with a ClickLearn account → you land on the wizard,
   with your real name in the top-right chip.
3. Submit a test request → you get a work item number, and the Task appears on your board with
   the title, description, priority, tags, and (if set) assigned to the Team Lead.

## Adjusting later
- **Dropdown options** (Request Type, Urgency): edit the tiles/pills in `frontend/request.html`.
- **Auto-routing to the 4 members:** in `api/createWorkItem/index.js`, replace the single
  `TEAM_LEAD_EMAIL` assignment with a map of request type → member UPN. Ask and I'll write it.
- **Custom DevOps fields** (e.g. a dedicated "Business justification" field): add a line to the
  `patch` array pointing at that field's reference name.

## A couple of honest caveats
- The two dropdown option lists are still my best-guess defaults — confirm them against your
  form so the choices match what your team expects.
- Attachments are uploaded to the work item; very large files near the 10 MB cap are slower to
  submit because they travel as base64 through the API.
