const https = require('https');
const querystring = require('querystring');

const SCOPES = ['https://www.googleapis.com/auth/photoslibrary.readonly'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PHOTOS_API = 'https://photoslibrary.googleapis.com/v1';

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
          reject(new Error(`Failed to parse response: ${data.substring(0, 200)}`));
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
    expiresAt: Date.now() + (data.expires_in * 1000) - 60000 // 1 min buffer
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

async function apiGet(url, accessToken) {
  const parsed = new URL(url);
  const { status, data } = await httpsRequest(parsed, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (status !== 200) {
    throw new Error(`Google API error ${status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function apiPost(url, accessToken, body) {
  const parsed = new URL(url);
  const postData = JSON.stringify(body);
  const { status, data } = await httpsRequest(parsed, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  if (status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (status !== 200) {
    throw new Error(`Google API error ${status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function listAlbums(accessToken, pageToken) {
  let url = `${PHOTOS_API}/albums?pageSize=50`;
  if (pageToken) url += `&pageToken=${pageToken}`;
  return apiGet(url, accessToken);
}

async function listMediaItems(accessToken, albumId, pageToken) {
  const body = {
    albumId,
    pageSize: 100
  };
  if (pageToken) body.pageToken = pageToken;
  return apiPost(`${PHOTOS_API}/mediaItems:search`, accessToken, body);
}

async function getMediaItem(accessToken, mediaItemId) {
  return apiGet(`${PHOTOS_API}/mediaItems/${mediaItemId}`, accessToken);
}

// Get all media items from selected albums (paginated)
async function getAllMediaFromAlbums(accessToken, albumIds) {
  const allItems = [];

  for (const albumId of albumIds) {
    let pageToken = null;
    do {
      const result = await listMediaItems(accessToken, albumId, pageToken);
      if (result.mediaItems) {
        allItems.push(...result.mediaItems);
      }
      pageToken = result.nextPageToken || null;
    } while (pageToken);
  }

  return allItems;
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  listAlbums,
  listMediaItems,
  getMediaItem,
  getAllMediaFromAlbums
};
