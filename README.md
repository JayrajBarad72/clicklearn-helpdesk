# ClickLearn Helpdesk

Internal request portal for the ClickLearn DevOps & IT team. Employees sign in with their
Microsoft account and submit a request; a Task is created automatically on the Azure DevOps board.

## Structure
- `frontend/index.html` — Microsoft sign-in gate (first screen)
- `frontend/request.html` — the guided request wizard
- `api/createWorkItem/` — Azure Function that creates the Azure DevOps Task
- `staticwebapp.config.json` — auth (Entra ID) + route protection
- `.github/workflows/` — CI/CD to Azure Static Web Apps
- `DEPLOYMENT.md` — **start here** to go live

## Flow
helpdesk.clicklearn.com → Microsoft sign-in → request wizard → Task on the DevOps board

See `DEPLOYMENT.md` for the full go-live steps.
