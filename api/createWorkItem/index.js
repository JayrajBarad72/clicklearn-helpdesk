/**
 * createWorkItem
 * Creates a Task on the Azure DevOps board from a helpdesk request.
 *
 * Required app settings:
 *   ADO_ORG, ADO_PROJECT, ADO_PAT   (Azure DevOps)
 *   TEAM_LEAD_EMAIL                  (optional; auto-assign for triage)
 *   ALLOW_ANONYMOUS                  (test only; "true" lets unsigned users submit)
 */

const PRIORITY_MAP = { Critical: 1, High: 2, Medium: 3, Low: 4 };

// Node 18+ has global fetch. If an older runtime is used, this stays undefined and
// we return a clear message instead of a silent crash.
const hasFetch = typeof fetch === 'function';

function reply(context, status, obj) {
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

function getSignedInUser(req) {
  const header = req.headers['x-ms-client-principal'];
  if (!header) return null;
  try {
    const p = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const nameClaim = (p.claims || []).find(
      c => c.typ === 'name' || /identity\/claims\/name$/.test(c.typ)
    );
    return { email: p.userDetails || '', name: nameClaim ? nameClaim.val : (p.userDetails || 'Unknown') };
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
    return reply(context, 500, { error: 'Server not configured: missing ADO_ORG / ADO_PROJECT / ADO_PAT.' });
  }
  if (!hasFetch) {
    return reply(context, 500, { error: 'API runtime is too old (needs Node 18+). Set apiRuntime to node:18.' });
  }

  let user = getSignedInUser(req);
  if (!user) {
    if (process.env.ALLOW_ANONYMOUS === 'true') {
      user = { email: 'test@clicklearn.com', name: 'Helpdesk Portal (test)' };
    } else {
      return reply(context, 401, { error: 'Not signed in.' });
    }
  }

  const body = req.body || {};
  const requestType = (body.requestType || 'General IT support').toString().slice(0, 80);
  const title = (body.title || '').toString().trim().slice(0, 255);
  const description = (body.description || '').toString().trim();
  const justification = (body.justification || '').toString().trim();
  const priority = PRIORITY_MAP[body.priority] ? body.priority : 'Medium';

  if (title.length < 3) return reply(context, 400, { error: 'Title is required.' });
  if (description.length < 10) return reply(context, 400, { error: 'Description is required.' });

  const htmlDescription =
    `<div><b>Request type:</b> ${esc(requestType)}</div>` +
    `<div><b>Priority:</b> ${esc(priority)}</div>` +
    `<br><div><b>Details</b></div><div>${esc(description).replace(/\n/g, '<br>')}</div>` +
    (justification ? `<br><div><b>Business justification</b></div><div>${esc(justification)}</div>` : '') +
    `<br><hr><div><i>Submitted via the Helpdesk portal by ${esc(user.name)} (${esc(user.email)})</i></div>`;

  const authHeader = 'Basic ' + Buffer.from(':' + ADO_PAT).toString('base64');
  const base = `https://dev.azure.com/${encodeURIComponent(ADO_ORG)}/${encodeURIComponent(ADO_PROJECT)}/_apis`;

  const patch = [
    { op: 'add', path: '/fields/System.Title', value: title },
    { op: 'add', path: '/fields/System.Description', value: htmlDescription },
    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: PRIORITY_MAP[priority] },
  ];
  // Tags are added only if the PAT/user has "Create tag definition" permission.
  // Set ADD_TAGS=true in app settings once that permission is granted.
  if (process.env.ADD_TAGS === 'true') {
    patch.push({ op: 'add', path: '/fields/System.Tags', value: ['Helpdesk', requestType, priority].join('; ') });
  }
  if (TEAM_LEAD_EMAIL) {
    patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: TEAM_LEAD_EMAIL });
  }

  try {
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
          patch.push({ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: up.url, attributes: { comment: 'Supporting document' } } });
        } else {
          context.log.warn('Attachment upload failed:', await upRes.text());
        }
      }
    }

    const createURL = `${base}/wit/workitems/$Task?api-version=7.1`;
    const res = await fetch(createURL, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(patch),
    });

    const text = await res.text();
    if (!res.ok) {
      context.log.error('DevOps create failed:', res.status, text);
      // Surface the real DevOps message during testing so we can diagnose fast.
      let detail = '';
      try { detail = JSON.parse(text).message || ''; } catch {}
      return reply(context, 502, { error: 'DevOps rejected the request (' + res.status + '). ' + detail });
    }

    const item = JSON.parse(text);
    const webUrl = `https://dev.azure.com/${ADO_ORG}/${encodeURIComponent(ADO_PROJECT)}/_workitems/edit/${item.id}`;
    return reply(context, 201, { id: item.id, url: webUrl });
  } catch (err) {
    context.log.error('Unexpected error:', err);
    return reply(context, 500, { error: 'Unexpected server error: ' + (err && err.message ? err.message : String(err)) });
  }
};
