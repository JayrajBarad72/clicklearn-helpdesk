/**
 * createWorkItem
 * Receives the helpdesk request from the signed-in employee and creates a
 * Task on the Azure DevOps board via the REST API.
 *
 * Auth: this endpoint sits behind Azure Static Web Apps authentication, so the
 * signed-in user's identity arrives in the `x-ms-client-principal` header —
 * we never trust a name/email sent from the browser.
 *
 * Required app settings (configured in the Static Web App, NOT in code):
 *   ADO_ORG           e.g. "clicklearn"        (dev.azure.com/<ADO_ORG>)
 *   ADO_PROJECT       e.g. "Helpdesk"
 *   ADO_PAT           the Personal Access Token (you generate it; store as a secret)
 *   TEAM_LEAD_EMAIL   (optional) UPN to assign new tasks to for triage
 */

const PRIORITY_MAP = { Critical: 1, High: 2, Medium: 3, Low: 4 };

function getSignedInUser(req) {
  const header = req.headers['x-ms-client-principal'];
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const p = JSON.parse(decoded);
    // userDetails is typically the email/UPN; claims hold the display name
    const nameClaim = (p.claims || []).find(
      c => c.typ === 'name' || c.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
    );
    return {
      email: p.userDetails || '',
      name: nameClaim ? nameClaim.val : (p.userDetails || 'Unknown'),
    };
  } catch {
    return null;
  }
}

function esc(s) {
  return String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

module.exports = async function (context, req) {
  const { ADO_ORG, ADO_PROJECT, ADO_PAT, TEAM_LEAD_EMAIL } = process.env;

  if (!ADO_ORG || !ADO_PROJECT || !ADO_PAT) {
    context.res = { status: 500, jsonBody: { error: 'Server is not configured. Missing Azure DevOps settings.' } };
    return;
  }

  let user = getSignedInUser(req);
  if (!user) {
    // TEST MODE (Free plan, no auth configured yet): allow submissions with a
    // placeholder requester so the flow can be verified. Set ALLOW_ANONYMOUS=true
    // in app settings to enable. REMOVE it in production once Entra ID sign-in is on.
    if (process.env.ALLOW_ANONYMOUS === 'true') {
      user = { email: 'test@clicklearn.com', name: 'Helpdesk Portal (test)' };
    } else {
      context.res = { status: 401, jsonBody: { error: 'Not signed in.' } };
      return;
    }
  }

  const body = req.body || {};
  const requestType = (body.requestType || 'General IT support').toString().slice(0, 80);
  const title = (body.title || '').toString().trim().slice(0, 255);
  const description = (body.description || '').toString().trim();
  const justification = (body.justification || '').toString().trim();
  const priority = PRIORITY_MAP[body.priority] ? body.priority : 'Medium';

  if (title.length < 3) {
    context.res = { status: 400, jsonBody: { error: 'Title is required.' } };
    return;
  }
  if (description.length < 10) {
    context.res = { status: 400, jsonBody: { error: 'Description is required.' } };
    return;
  }

  // Rich HTML description shown on the work item
  const htmlDescription =
    `<div><b>Request type:</b> ${esc(requestType)}</div>` +
    `<div><b>Priority:</b> ${esc(priority)}</div>` +
    `<br><div><b>Details</b></div><div>${esc(description).replace(/\n/g, '<br>')}</div>` +
    (justification ? `<br><div><b>Business justification</b></div><div>${esc(justification)}</div>` : '') +
    `<br><hr><div><i>Submitted via the Helpdesk portal by ${esc(user.name)} (${esc(user.email)})</i></div>`;

  const authHeader = 'Basic ' + Buffer.from(':' + ADO_PAT).toString('base64');
  const base = `https://dev.azure.com/${encodeURIComponent(ADO_ORG)}/${encodeURIComponent(ADO_PROJECT)}/_apis`;

  // Build the JSON-Patch document that defines the Task
  const patch = [
    { op: 'add', path: '/fields/System.Title', value: title },
    { op: 'add', path: '/fields/System.Description', value: htmlDescription },
    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: PRIORITY_MAP[priority] },
    { op: 'add', path: '/fields/System.Tags', value: ['Helpdesk', requestType, priority].join('; ') },
  ];

  // One shared board: assign to the Team Lead for triage (optional).
  if (TEAM_LEAD_EMAIL) {
    patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: TEAM_LEAD_EMAIL });
  }

  try {
    // --- optional attachment: upload first, then link it ---
    if (body.attachment && body.attachment.contentBase64 && body.attachment.name) {
      const bytes = Buffer.from(body.attachment.contentBase64, 'base64');
      if (bytes.length <= 10 * 1024 * 1024) {
        const upURL = `${base}/wit/attachments?fileName=${encodeURIComponent(body.attachment.name)}&api-version=7.1`;
        const upRes = await fetch(upURL, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
        if (upRes.ok) {
          const up = await upRes.json();
          patch.push({
            op: 'add',
            path: '/relations/-',
            value: { rel: 'AttachedFile', url: up.url, attributes: { comment: 'Supporting document' } },
          });
        } else {
          context.log.warn('Attachment upload failed:', await upRes.text());
        }
      }
    }

    // --- create the Task ---
    const createURL = `${base}/wit/workitems/$Task?api-version=7.1`;
    const res = await fetch(createURL, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(patch),
    });

    if (!res.ok) {
      const text = await res.text();
      context.log.error('DevOps create failed:', res.status, text);
      context.res = { status: 502, jsonBody: { error: 'Could not create the work item. Please try again or contact IT.' } };
      return;
    }

    const item = await res.json();
    const webUrl = `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_workitems/edit/${item.id}`;
    context.res = { status: 201, jsonBody: { id: item.id, url: webUrl } };
  } catch (err) {
    context.log.error('Unexpected error:', err);
    context.res = { status: 500, jsonBody: { error: 'Unexpected server error.' } };
  }
};
