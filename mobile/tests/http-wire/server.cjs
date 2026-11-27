const http = require('node:http');
const assert = require('node:assert/strict');

const service = { id: 'wire-service', name: 'Услуга HTTP', description: 'Тестовая услуга' };
const initialOrder = {
  id: 'wire-order', serviceId: service.id, serviceSnapshot: service, title: 'Заказ HTTP',
  agreements: 'Вёрстка первого экрана', completedWork: 'Первый вариант отправлен', deadline: '2026-12-04', status: 'active', revision: 1,
  createdAt: '2026-11-27T08:00:00Z', updatedAt: '2026-11-27T08:00:00Z',
};
let order = initialOrder;
const fixtureToken = 'wire-fixture-session';
const version = {
  id: 'wire-version-1', proposalId: 'wire-proposal', version: 1, author: 'freelancer', baseOrderRevision: 1,
  createdAt: order.updatedAt, title: 'Дополнительный макет',
  items: [{ id: 'wire-item', title: 'Новый макет', description: '', category: 'extra', reason: '', price: null }],
  deadline: null, conditions: '', comment: null,
};
const counter = { ...version, id: 'wire-version-2', version: 2, author: 'client', conditions: 'Согласовать по электронной почте' };
let proposal;
let publishedReads = 0;
let imports = 0;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readForm(req) {
  const contentType = req.headers['content-type'];
  assert.match(contentType ?? '', /^multipart\/form-data;\s*boundary=/i);
  return new Response(await readRequest(req), { headers: { 'Content-Type': contentType } }).formData();
}

http.createServer(async (req, res) => {
  try {
    const route = `${req.method} ${req.url}`;
    if (route === 'POST /api/v1/session') {
      if (req.headers.authorization || (await readRequest(req)).toString() !== '{}') throw new Error('Invalid session request');
      proposal = undefined;
      order = initialOrder;
      imports = 0;
      publishedReads = 0;
      return send(res, 201, { token: fixtureToken });
    }
    if (req.headers.authorization !== `Bearer ${fixtureToken}`) throw new Error('Invalid authorization');
    switch (route) {
      case 'GET /api/v1/orders': return send(res, 200, imports >= 2 ? [{ ...order, openProposalStatus: proposal?.status ?? null }] : []);
      case 'GET /api/v1/services':
        await new Promise((resolve) => setTimeout(resolve, 400));
        return send(res, 200, [service]);
      case 'GET /api/v1/services/wire-service': return send(res, 200, service);
      case 'GET /api/v1/orders/wire-order': return send(res, 200, { order, proposals: proposal ? [proposal] : [] });
      case 'PATCH /api/v1/orders/wire-order': {
        const input = JSON.parse((await readRequest(req)).toString());
        assert.deepEqual(input, { title: 'Заказ HTTP', agreements: 'Уточнили описание', deadline: null });
        order = { ...order, ...input, revision: order.revision + 1 };
        return send(res, 200, order);
      }
      case 'POST /api/v1/orders/import': {
        const form = await readForm(req);
        assert.deepEqual([...form.keys()], ['text', 'files', 'files', 'serviceId']);
        assert.equal(form.get('text'), 'Согласовали формат');
        assert.equal(form.get('serviceId'), service.id);
        assert.deepEqual(form.getAll('files').map((file) => file.name), ['one.png', 'two.png']);
        for (const file of form.getAll('files')) {
          assert.deepEqual([...new Uint8Array(await file.arrayBuffer()).slice(0, 4)], [137, 80, 78, 71]);
        }
        imports++;
        if (imports % 2 === 1) return send(res, 502, { error: { code: 'AI_FAILED', message: 'Тестовый сбой обработки AI.' } });
        return send(res, 201, { order, proposal: null, version: null });
      }
      case 'POST /api/v1/orders/wire-order/proposals': {
        const form = await readForm(req);
        assert.deepEqual([...form.keys()], ['text']);
        assert.equal(form.get('text'), 'Новый макет');
        proposal = {
          id: version.proposalId, orderId: order.id, title: version.title, status: 'draft', currentVersionId: version.id,
          publishedVersionId: null, approvedVersionId: null, shareUrl: null, createdAt: version.createdAt, updatedAt: version.createdAt,
        };
        return send(res, 201, { proposal, version });
      }
      case 'GET /api/v1/proposals/wire-proposal': {
        assert.ok(proposal);
        if (proposal.status === 'pending' && ++publishedReads === 2) {
          proposal = { ...proposal, status: 'countered', currentVersionId: counter.id };
        }
        return send(res, 200, { proposal, versions: proposal.status === 'countered' ? [version, counter] : [version] });
      }
      case 'POST /api/v1/proposals/wire-proposal/publish': {
        const input = JSON.parse((await readRequest(req)).toString());
        assert.deepEqual(input, { expectedVersionId: version.id, format: 'text' });
        proposal = { ...proposal, status: 'pending', publishedVersionId: version.id };
        return send(res, 200, { proposal, version });
      }
      case 'POST /api/v1/proposals/wire-proposal/revise': {
        const form = await readForm(req);
        assert.deepEqual([...form.keys()], ['text', 'expectedVersionId']);
        assert.equal(form.get('text'), 'Уточнить сроки');
        assert.equal(form.get('expectedVersionId'), counter.id);
        return send(res, 409, { error: { code: 'VERSION_CONFLICT', message: 'Тестовый конфликт версии.' } });
      }
      default: return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Нет тестового маршрута.' } });
    }
  } catch {
    send(res, 422, { error: { code: 'VALIDATION_ERROR', message: 'Тестовый сервер получил запрос вне контракта.' } });
  }
}).listen(49335, '127.0.0.1', () => process.stdout.write('HTTP fixture ready\n'));
