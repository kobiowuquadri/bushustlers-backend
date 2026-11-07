import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import sequelize from '../src/database/db.js';
import { AuthSession, EmailOutbox } from '../src/schemas/index.js';
import { browser, ORIGIN, uniqueEmail } from './helpers.js';

afterAll(async () => {
  await sequelize.close();
});

const cookieNames = (res: request.Response) => ((res.headers['set-cookie'] as unknown as string[]) || []).map((c) => c.split('=')[0]);

describe('authentication', () => {
  it('registers with HttpOnly session cookies and never returns tokens in the body', async () => {
    const client = await browser();
    const res = await client.send('post', '/api/v1/auth/register', { fullName: 'Amaka Obi', email: uniqueEmail('reg'), password: 'Linen-set-104!' });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken|refreshToken|password/);
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/bh_access=.*HttpOnly/);
    expect(cookies).toMatch(/bh_session=.*HttpOnly/);
    expect(cookies).toMatch(/SameSite=Lax/);
    const me = await client.send('get', '/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.emailVerified).toBe(false);
    expect(me.body.data.onboardingComplete).toBe(false);
  });

  it('rejects state-changing requests without the CSRF header', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: 'x@example.com', password: 'y' });
    expect(res.status).toBe(403);
    expect(res.body.data.code).toBe('csrf_failed');
  });

  it('rejects requests from origins that are not allowed', async () => {
    const client = await browser();
    const res = await client.agent.post('/api/v1/auth/login').set('Origin', 'https://evil.example').set('X-CSRF-Token', client.csrf).send({ email: 'x@example.com', password: 'y' });
    expect(res.status).toBe(403);
    expect(res.body.data.code).toBe('origin_not_allowed');
  });

  it('uses the same message for an unknown email and a wrong password', async () => {
    const client = await browser();
    const email = uniqueEmail('login');
    await client.send('post', '/api/v1/auth/register', { fullName: 'Amaka Obi', email, password: 'Linen-set-104!' });
    const other = await browser();
    const wrong = await other.send('post', '/api/v1/auth/login', { email, password: 'Wrong-pass-1!' });
    const unknown = await other.send('post', '/api/v1/auth/login', { email: uniqueEmail('nobody'), password: 'Wrong-pass-1!' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('rotates refresh tokens and ends the session if an old token is replayed', async () => {
    const client = await browser();
    const registered = await client.send('post', '/api/v1/auth/register', { fullName: 'Amaka Obi', email: uniqueEmail('rotate'), password: 'Linen-set-104!' });
    const session = await AuthSession.findOne({ order: [['id', 'DESC']] });
    const refreshCookie = ((registered.headers['set-cookie'] as unknown as string[]) || [])
      .map((c) => c.split(';')[0])
      .find((pair) => pair.startsWith('bh_session='))
      ?.slice('bh_session='.length);
    expect(refreshCookie).toBeTruthy();
    const first = await client.send('post', '/api/v1/auth/refresh');
    expect(first.status).toBe(200);
    expect(cookieNames(first)).toContain('bh_session');

    // Make the rotation older than the grace window, then replay the original token
    await AuthSession.update({ rotatedAt: new Date(Date.now() - 60_000) }, { where: { id: session!.id } });
    if (refreshCookie) {
      const replay = await request(app).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', [`bh_session=${refreshCookie}`, `bh_csrf=${client.csrf}`]).set('X-CSRF-Token', client.csrf);
      expect(replay.status).toBe(401);
      const revoked = await AuthSession.findByPk(session!.id);
      expect(revoked?.revokedReason).toBe('refresh_reuse');
    }
  });

  it('signs out and revokes the session immediately', async () => {
    const client = await browser();
    await client.send('post', '/api/v1/auth/register', { fullName: 'Amaka Obi', email: uniqueEmail('logout'), password: 'Linen-set-104!' });
    expect((await client.send('post', '/api/v1/auth/logout')).status).toBe(200);
    const me = await client.send('get', '/api/v1/auth/me');
    expect(me.status).toBe(401);
  });

  it('verifies email and resets a password through single-use links (dev mailbox, no tokens in logs)', async () => {
    const client = await browser();
    const email = uniqueEmail('reset');
    await client.send('post', '/api/v1/auth/register', { fullName: 'Amaka Obi', email, password: 'Linen-set-104!' });

    // Handlebars escapes "=" as &#x3D; inside the link (valid HTML; browsers decode it in href)
    const decode = (html: string) => html.replace(/&#x3D;/g, '=').replace(/&amp;/g, '&');
    const verifyEmail = await EmailOutbox.findOne({ where: { toEmail: email, template: 'verify-email' }, order: [['id', 'DESC']] });
    const verifyToken = decode(verifyEmail!.html!).match(/verify-email\?token=([A-Za-z0-9_-]+)/)![1];
    expect((await client.send('post', '/api/v1/auth/verify-email', { token: verifyToken })).status).toBe(200);
    expect((await client.send('post', '/api/v1/auth/verify-email', { token: verifyToken })).status).toBe(422);
    expect((await client.send('get', '/api/v1/auth/me')).body.data.user.emailVerified).toBe(true);

    const anon = await browser();
    const forgot = await anon.send('post', '/api/v1/auth/forgot-password', { email });
    const forgotUnknown = await anon.send('post', '/api/v1/auth/forgot-password', { email: uniqueEmail('missing') });
    expect(forgot.status).toBe(200);
    expect(forgot.body.message).toBe(forgotUnknown.body.message);

    const resetEmail = await EmailOutbox.findOne({ where: { toEmail: email, template: 'reset-password' }, order: [['id', 'DESC']] });
    const resetToken = decode(resetEmail!.html!).match(/reset-password\?token=([A-Za-z0-9_-]+)/)![1];
    expect((await anon.send('post', '/api/v1/auth/reset-password', { token: resetToken, password: 'New-linen-set-105!' })).status).toBe(200);
    // Existing sessions were revoked by the reset
    expect((await client.send('get', '/api/v1/auth/me')).status).toBe(401);
    const login = await anon.send('post', '/api/v1/auth/login', { email, password: 'New-linen-set-105!' });
    expect(login.status).toBe(200);
  });
});
