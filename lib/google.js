const https = require('https');
const querystring = require('querystring');

// Google Photos Picker API (not the Library API)
const SCOPES = ['https://www.googleapis.com/auth/photospicker.mediaitems.readonly'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PICKER_API = 'https://photospicker.googleapis.com/v1';

function getAuthUrl(clientId, redirectUri) {
  const params = querystring.stringify({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent'
  });
  return `${AUTH_URL}?${params}`;
}

function httpsRequest(url, options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data.substring(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function exchangeCode(code, clientId, clientSecret, redirectUri) {
  const postData = querystring.stringify({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  const { status, data } = await httpsRequest(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  if (status !== 200 || data.error) {
    throw new Error(`Token exchange failed: ${data.error_description || data.error || status}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - 60000
  };
}

async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const postData = querystring.stringify({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token'
  });

  const { status, data } = await httpsRequest(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  if (status !== 200 || data.error) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error || status}`);
  }

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - 60000
  };
}

async function apiRequest(method, url, accessToken, body) {
  const parsed = new URL(url);
  const headers = { 'Authorization': `Bearer ${accessToken}` };
  let postData;

  if (body) {
    postData = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(postData);
  }

  const { status, data } = await httpsRequest(parsed, { method, headers }, postData);

  if (status === 401) throw new Error('UNAUTHORIZED');
  if (status < 200 || status >= 300) {
    throw new Error(`Google API error ${status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Create a picker session — returns { id, pickerUri, expireTime, mediaItemsSet }
async function createSession(accessToken) {
  return apiRequest('POST', `${PICKER_API}/sessions`, accessToken, {});
}

// Poll a picker session for results
async function getSession(accessToken, sessionId) {
  return apiRequest('GET', `${PICKER_API}/sessions/${sessionId}`, accessToken);
}

// List media items from a completed picker session (paginated)
async function listPickedItems(accessToken, sessionId, pageToken) {
  let url = `${PICKER_API}/mediaItems?sessionId=${sessionId}&pageSize=100`;
  if (pageToken) url += `&pageToken=${pageToken}`;
  return apiRequest('GET', url, accessToken);
}

// Get all picked media items from a session
async function getAllPickedItems(accessToken, sessionId) {
  const allItems = [];
  let pageToken = null;

  do {
    const result = await listPickedItems(accessToken, sessionId, pageToken);
    if (result.mediaItems) {
      allItems.push(...result.mediaItems);
    }
    pageToken = result.nextPageToken || null;
  } while (pageToken);

  return allItems;
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  createSession,
  getSession,
  listPickedItems,
  getAllPickedItems
};
