import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { createDeepSeekProxy } from '../server/deepseek-proxy.mjs'

async function harness(t, env = { DEEPSEEK_API_KEY: 'test-only' }, fetchImpl = async () => new Response('{}')) {
  const server = createServer(createDeepSeekProxy({ env, fetchImpl }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return `http://127.0.0.1:${server.address().port}`
}

test('only the server credential is sent upstream; model and SSE responses work', async t => {
  const calls = []
  const url = await harness(t, undefined, async (url, init) => {
    calls.push({ url, init })
    return url.endsWith('/models')
      ? new Response(JSON.stringify({ data: [{ id: 'fake-model' }] }), { headers: { 'content-type': 'application/json' } })
      : new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const models = await fetch(`${url}/api/deepseek/models`, { headers: { Authorization: 'Bearer browser' } })
  assert.deepEqual(await models.json(), { data: [{ id: 'fake-model' }] })
  const chat = await fetch(`${url}/api/deepseek/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'test' }], stream: true })
  })
  assert.equal(chat.headers.get('content-type'), 'text/event-stream')
  assert.match(await chat.text(), /data: \[DONE\]/)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-only')
  assert.equal(calls[1].init.redirect, 'error')
  assert.equal(JSON.parse(calls[1].init.body).messages[0].content, 'test')
})

test('missing environment key fails without exposing environment values', async t => {
  const url = await harness(t, {})
  const response = await fetch(`${url}/api/deepseek/models`)
  assert.equal(response.status, 503)
  assert.match(await response.text(), /DEEPSEEK_API_KEY/)
})

test('cross-site, invalid hosts, arbitrary routes, malformed JSON and methods are rejected', async t => {
  let calls = 0
  const url = await harness(t, undefined, async () => { calls++; return new Response('{}') })
  assert.equal((await fetch(`${url}/api/deepseek/models`, { headers: { Origin: 'https://attacker.example' } })).status, 403)
  // fetch normalizes Host; use HTTP directly to exercise an actual hostile Host header.
  const hostileHostStatus = await new Promise((resolve, reject) => {
    request(`${url}/api/deepseek/models`, { headers: { Host: 'attacker.example' } }, response => {
      response.resume(); resolve(response.statusCode)
    }).on('error', reject).end()
  })
  assert.equal(hostileHostStatus, 403)
  assert.equal((await fetch(`${url}/api/deepseek/models`, { headers: { Origin: 'null' } })).status, 403)
  assert.equal((await fetch(`${url}/api/deepseek/other`)).status, 404)
  assert.equal((await fetch(`${url}/api/deepseek/models`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${url}/api/deepseek/chat/completions`, { method: 'POST', body: '{broken' })).status, 400)
  assert.equal((await fetch(`${url}/api/deepseek/chat/completions`, { method: 'POST', body: '{}' })).status, 400)
  assert.equal(calls, 0)
})

test('provider errors and exceptions cannot expose secret-bearing error details', async t => {
  for (const throws of [false, true]) {
    const url = await harness(t, undefined, async () => {
      if (throws) throw new Error('request contains test-only')
      return new Response('{"error":{"message":"test-only"}}', { status: 401 })
    })
    const response = await fetch(`${url}/api/deepseek/models`)
    assert.equal(response.status, throws ? 502 : 401)
    assert.equal((await response.text()).includes('test-only'), false)
  }
})
