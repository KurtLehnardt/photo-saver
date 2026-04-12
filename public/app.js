(function() {
  'use strict';

  // State
  var slides = [];
  var shuffledOrder = [];
  var currentIndex = -1;
  var settings = {
    shuffle: true,
    transition: 'fade',
    kenBurns: true,
    muted: true,
    duration: 8,
    paused: false
  };
  var timer = null;
  var controlsTimer = null;
  var overlayTimer = null;
  var activeLayer = 'a';
  var isShowingOverlay = false;
  var isShowingControls = false;
  var source = localStorage.getItem('frameflow_source') || null; // 'local' or 'google'

  // DOM refs
  const layerA = document.getElementById('layer-a');
  const layerB = document.getElementById('layer-b');
  const overlay = document.getElementById('overlay');
  const controls = document.getElementById('controls');
  const settingsPanel = document.getElementById('settings-panel');
  const hiddenPanel = document.getElementById('hidden-panel');
  const loading = document.getElementById('loading');
  const wakeVideo = document.getElementById('wake-video');
  const sourcePicker = document.getElementById('source-picker');

  // ===== Wake Lock =====
  function acquireWakeLock() {
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').catch(function() {
        // Fallback to video trick
        startWakeVideo();
      });
    } else {
      startWakeVideo();
    }
  }

  function startWakeVideo() {
    // Small transparent video data URI to keep screen awake
    wakeVideo.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAChtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE1MAAAABhzdHRzAAAAAAAAAAEAAAABAAAEAAAAABRzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAUc3RzegAAAAAAAAACAAAAAgAAABRzdGNvAAAAAAAAAAEAAAAsAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY1OC43Ni4xMDA=';
    wakeVideo.play().catch(function() {});
  }

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      acquireWakeLock();
    }
  });

  // ===== API =====
  function fetchSlides() {
    var url = source === 'google' ? '/api/google/slides' : '/api/slides';
    var attempt = 0;
    var maxAttempts = 3;

    function tryFetch() {
      return fetch(url).then(function(res) {
        if (res.status === 401 && source === 'google') {
          window.location.href = '/api/google/auth';
          return [];
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function(data) {
        return data.slides;
      }).catch(function(err) {
        console.warn('[app] Fetch slides attempt ' + (attempt + 1) + ' failed:', err.message);
        attempt++;
        if (attempt < maxAttempts) {
          return new Promise(function(r) { setTimeout(r, 2000 * attempt); }).then(tryFetch);
        }
        return [];
      });
    }

    return tryFetch();
  }

  function fetchSettings() {
    return fetch('/api/settings').then(function(res) {
      if (res.ok) {
        return res.json();
      }
      return null;
    }).catch(function() {
      return null;
    });
  }

  function saveSettings(partial) {
    return fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial)
    }).catch(function() {});
  }

  function hideSlide(id) {
    return fetch('/api/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id })
    }).catch(function() {});
  }

  function unhideSlide(id) {
    return fetch('/api/unhide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id })
    }).catch(function() {});
  }

  function fetchHidden() {
    return fetch('/api/hidden').then(function(res) {
      if (res.ok) {
        return res.json().then(function(data) { return data.hidden; });
      }
      return [];
    }).catch(function() {
      return [];
    });
  }

  // ===== Shuffle =====
  function buildShuffleOrder() {
    shuffledOrder = slides.map(function(_, i) { return i; });
    for (let i = shuffledOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffledOrder[i];
      shuffledOrder[i] = shuffledOrder[j];
      shuffledOrder[j] = tmp;
    }
  }

  let shuffleIndex = 0;

  function getNextIndex() {
    if (slides.length === 0) return -1;

    if (settings.shuffle) {
      if (shuffleIndex >= shuffledOrder.length) {
        buildShuffleOrder();
        shuffleIndex = 0;
      }
      const idx = shuffledOrder[shuffleIndex];
      shuffleIndex++;
      return idx;
    } else {
      return (currentIndex + 1) % slides.length;
    }
  }

  function getPrevIndex() {
    if (slides.length === 0) return -1;
    if (currentIndex <= 0) return slides.length - 1;
    return currentIndex - 1;
  }

  // ===== Ken Burns =====
  const KB_CLASSES = ['kb-1', 'kb-2', 'kb-3', 'kb-4'];

  function applyKenBurns(layer) {
    // Remove old KB classes
    KB_CLASSES.forEach(function(c) { layer.classList.remove(c); });
    layer.classList.remove('kenburns');

    if (settings.kenBurns) {
      const variant = KB_CLASSES[Math.floor(Math.random() * KB_CLASSES.length)];
      layer.classList.add('kenburns', variant);
    }
  }

  // ===== Slideshow Engine =====
  function getInactiveLayer() {
    if (activeLayer === 'a') return layerB;
    return layerA;
  }

  function getActiveLayerEl() {
    if (activeLayer === 'a') return layerA;
    return layerB;
  }

  function swapLayers() {
    const incoming = getInactiveLayer();
    const outgoing = getActiveLayerEl();

    // Apply transition
    if (settings.transition === 'fade' || settings.transition === 'dissolve') {
      incoming.classList.add('active');
      outgoing.classList.remove('active');
    } else if (settings.transition === 'slide') {
      incoming.classList.remove('slide-enter', 'slide-exit');
      outgoing.classList.remove('slide-enter', 'slide-exit');
      // Force reflow
      void incoming.offsetWidth;
      incoming.classList.add('slide-enter');
      void incoming.offsetWidth;
      incoming.classList.add('active');
      outgoing.classList.add('slide-exit');
      outgoing.classList.remove('active');
    } else {
      // none
      incoming.classList.add('no-transition');
      incoming.classList.add('active');
      outgoing.classList.remove('active');
      setTimeout(function() { incoming.classList.remove('no-transition'); }, 50);
    }

    activeLayer = activeLayer === 'a' ? 'b' : 'a';
  }

  function clearLayer(layer) {
    KB_CLASSES.forEach(function(c) { layer.classList.remove(c); });
    layer.classList.remove('kenburns', 'slide-enter', 'slide-exit', 'no-transition');
    layer.innerHTML = '';
  }

  function loadSlide(index, direction) {
    if (index < 0 || index >= slides.length) return;

    const slide = slides[index];
    const layer = getInactiveLayer();
    clearLayer(layer);

    currentIndex = index;

    if (slide.type === 'image') {
      const img = document.createElement('img');
      img.onload = function() {
        applyKenBurns(layer);
        swapLayers();
        scheduleNext();
      };
      img.onerror = function() {
        console.warn('[app] Failed to load image:', slide.src);
        // Skip broken image
        setTimeout(function() { showNext(); }, 100);
      };
      img.src = slide.src;
      img.alt = slide.filename || '';
      layer.appendChild(img);
    } else {
      // Video
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.muted = settings.muted;
      video.setAttribute('muted', '');
      video.preload = 'auto';

      video.oncanplay = function() {
        // Unmute after autoplay starts if user wants sound
        if (!settings.muted) {
          video.muted = false;
        }
        swapLayers();
      };

      video.onended = function() {
        showNext();
      };

      video.onerror = function() {
        console.warn('[app] Failed to load video:', slide.src);
        setTimeout(function() { showNext(); }, 100);
      };

      // Fallback timer in case ended never fires
      video.onloadedmetadata = function() {
        const fallbackTime = Math.max(video.duration * 2, 30) * 1000;
        // Clear slide timer, use video duration
        clearTimeout(timer);
        timer = setTimeout(function() {
          if (!video.ended) {
            showNext();
          }
        }, fallbackTime);
      };

      const source = document.createElement('source');
      source.src = slide.src;
      video.appendChild(source);
      layer.appendChild(video);
    }
  }

  function showNext() {
    clearTimeout(timer);
    const idx = getNextIndex();
    if (idx >= 0) loadSlide(idx, 'next');
  }

  function showPrev() {
    clearTimeout(timer);
    const idx = getPrevIndex();
    if (idx >= 0) loadSlide(idx, 'prev');
  }

  function scheduleNext() {
    clearTimeout(timer);
    if (!settings.paused && slides.length > 0) {
      timer = setTimeout(showNext, settings.duration * 1000);
    }
  }

  // ===== Controls =====
  function showControls() {
    controls.classList.remove('hidden');
    isShowingControls = true;
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(hideControls, 5000);
  }

  function hideControls() {
    controls.classList.add('hidden');
    isShowingControls = false;
  }

  function showOverlay() {
    overlay.classList.remove('hidden');
    isShowingOverlay = true;
    showControls();
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(hideOverlay, 5000);
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
    isShowingOverlay = false;
  }

  // Tap on slideshow area
  document.getElementById('slideshow').addEventListener('click', function(e) {
    if (settingsPanel.classList.contains('hidden') && hiddenPanel.classList.contains('hidden')) {
      if (isShowingOverlay) {
        hideOverlay();
        hideControls();
      } else {
        showOverlay();
      }
    }
  });

  // Hide button
  document.getElementById('btn-hide').addEventListener('click', function(e) {
    e.stopPropagation();
    if (currentIndex >= 0 && currentIndex < slides.length) {
      const slide = slides[currentIndex];
      hideSlide(slide.id).then(function() {
        slides.splice(currentIndex, 1);
        buildShuffleOrder();
        shuffleIndex = 0;
        hideOverlay();
        if (slides.length > 0) {
          if (currentIndex >= slides.length) currentIndex = 0;
          showNext();
        }
      });
    }
  });

  // Play/pause
  document.getElementById('btn-playpause').addEventListener('click', function(e) {
    e.stopPropagation();
    settings.paused = !settings.paused;
    const btn = document.getElementById('btn-playpause');
    const svg = btn.querySelector('svg use');
    if (settings.paused) {
      svg.setAttribute('href', 'icons.svg#icon-play');
      clearTimeout(timer);
    } else {
      svg.setAttribute('href', 'icons.svg#icon-pause');
      scheduleNext();
    }
    saveSettings({ paused: settings.paused });
    showControls();
  });

  // Next / Prev
  document.getElementById('btn-next').addEventListener('click', function(e) {
    e.stopPropagation();
    showNext();
    showControls();
  });

  document.getElementById('btn-prev').addEventListener('click', function(e) {
    e.stopPropagation();
    showPrev();
    showControls();
  });

  // Settings toggle
  document.getElementById('btn-settings').addEventListener('click', function(e) {
    e.stopPropagation();
    settingsPanel.classList.toggle('hidden');
    hideOverlay();
  });

  document.getElementById('btn-close-settings').addEventListener('click', function(e) {
    e.stopPropagation();
    settingsPanel.classList.add('hidden');
  });

  // Settings controls
  document.getElementById('set-shuffle').addEventListener('change', function(e) {
    settings.shuffle = e.target.checked;
    if (settings.shuffle) {
      buildShuffleOrder();
      shuffleIndex = 0;
    }
    saveSettings({ shuffle: settings.shuffle });
  });

  document.getElementById('set-transition').addEventListener('change', function(e) {
    settings.transition = e.target.value;
    saveSettings({ transition: settings.transition });
  });

  document.getElementById('set-kenburns').addEventListener('change', function(e) {
    settings.kenBurns = e.target.checked;
    saveSettings({ kenBurns: settings.kenBurns });
  });

  document.getElementById('set-muted').addEventListener('change', function(e) {
    settings.muted = e.target.checked;
    // Update any currently playing video
    const activeLayerEl = getActiveLayerEl();
    const video = activeLayerEl.querySelector('video');
    if (video) {
      video.muted = settings.muted;
    }
    saveSettings({ muted: settings.muted });
  });

  document.getElementById('set-duration').addEventListener('input', function(e) {
    settings.duration = parseInt(e.target.value, 10);
    document.getElementById('duration-value').textContent = settings.duration + 's';
  });

  document.getElementById('set-duration').addEventListener('change', function(e) {
    settings.duration = parseInt(e.target.value, 10);
    saveSettings({ duration: settings.duration });
  });

  // Rescan button
  document.getElementById('btn-rescan').addEventListener('click', function(e) {
    e.stopPropagation();
    const btn = e.target;
    btn.textContent = 'Scanning...';
    btn.disabled = true;
    fetch('/api/rescan', { method: 'POST' }).then(function(res) {
      if (res.ok) {
        return res.json().then(function(data) {
          btn.textContent = 'Found ' + data.current + ' files. Reloading...';
          return fetchSlides().then(function(newSlides) {
            slides = newSlides;
            buildShuffleOrder();
            shuffleIndex = 0;
            currentIndex = -1;
            setTimeout(function() {
              btn.textContent = 'Rescan Photos Library';
              btn.disabled = false;
              showNext();
            }, 1500);
          });
        });
      }
    }).catch(function() {
      btn.textContent = 'Scan failed. Try again.';
      btn.disabled = false;
    });
  });

  // Hidden photos management
  document.getElementById('btn-manage-hidden').addEventListener('click', function(e) {
    e.stopPropagation();
    settingsPanel.classList.add('hidden');
    hiddenPanel.classList.remove('hidden');

    const grid = document.getElementById('hidden-grid');
    grid.innerHTML = '<div class="loading-text">Loading...</div>';

    fetchHidden().then(function(hiddenItems) {
      grid.innerHTML = '';

      if (hiddenItems.length === 0) {
        grid.innerHTML = '<div class="loading-text" style="padding:20px;width:100%">No hidden photos</div>';
        return;
      }

      hiddenItems.forEach(function(item) {
        const div = document.createElement('div');
        div.className = 'hidden-item';

        const img = document.createElement('img');
        img.src = item.src;
        img.alt = item.filename || '';

        const btn = document.createElement('button');
        btn.textContent = 'Unhide';
        btn.addEventListener('click', function() {
          unhideSlide(item.id).then(function() {
            div.remove();
            // Refresh slides
            fetchSlides().then(function(newSlides) {
              slides = newSlides;
              buildShuffleOrder();
              shuffleIndex = 0;
            });
          });
        });

        div.appendChild(img);
        div.appendChild(btn);
        grid.appendChild(div);
      });
    });
  });

  document.getElementById('btn-close-hidden').addEventListener('click', function(e) {
    e.stopPropagation();
    hiddenPanel.classList.add('hidden');
  });

  // ===== Apply Settings to UI =====
  function applySettingsToUI() {
    document.getElementById('set-shuffle').checked = settings.shuffle;
    document.getElementById('set-transition').value = settings.transition;
    document.getElementById('set-kenburns').checked = settings.kenBurns;
    document.getElementById('set-muted').checked = settings.muted;
    document.getElementById('set-duration').value = settings.duration;
    document.getElementById('duration-value').textContent = settings.duration + 's';

    const btn = document.getElementById('btn-playpause');
    const svg = btn.querySelector('svg use');
    if (settings.paused) {
      svg.setAttribute('href', 'icons.svg#icon-play');
    } else {
      svg.setAttribute('href', 'icons.svg#icon-pause');
    }
  }

  // ===== Source Picker =====
  function checkGoogleStatus() {
    return fetch('/api/google/status').then(function(res) {
      if (res.ok) {
        return res.json().then(function(data) {
          var statusText = document.getElementById('google-status-text');
          if (!data.configured) {
            statusText.textContent = 'Not configured on server';
            document.getElementById('src-google').disabled = true;
          } else if (data.authenticated) {
            statusText.textContent = 'Connected \u2713';
          } else {
            statusText.textContent = 'Connect your account';
          }
          return data;
        });
      }
      return { configured: false, authenticated: false };
    }).catch(function() {
      return { configured: false, authenticated: false };
    });
  }

  function showSourcePicker() {
    loading.classList.add('hidden');
    sourcePicker.classList.remove('hidden');
    checkGoogleStatus();
  }

  function selectSource(src) {
    source = src;
    localStorage.setItem('frameflow_source', src);

    if (src === 'local') {
      sourcePicker.classList.add('hidden');
      startSlideshow();
    } else if (src === 'google') {
      checkGoogleStatus().then(function(status) {
        if (!status.authenticated) {
          window.location.href = '/api/google/auth';
          return;
        }
        // If already have picked photos, go straight to slideshow
        if (status.hasPickedPhotos) {
          sourcePicker.classList.add('hidden');
          startSlideshow();
          return;
        }
        // Otherwise open the Google picker
        sourcePicker.classList.add('hidden');
        openGooglePicker();
      });
    }
  }

  // ===== Google Photos Picker =====
  var pickerWindow = null;
  var pickerPollTimer = null;

  function openGooglePicker() {
    loading.classList.remove('hidden');
    loading.querySelector('.loading-text').textContent = 'Opening Google Photos picker...';

    fetch('/api/google/picker', { method: 'POST' }).then(function(res) {
      if (res.status === 401) {
        window.location.href = '/api/google/auth';
        return null;
      }
      if (!res.ok) throw new Error('Failed to create picker session');
      return res.json();
    }).then(function(data) {
      if (!data) return;

      loading.querySelector('.loading-text').textContent = 'Select photos in the Google picker window, then come back here.';

      // Open Google's picker in a new window/tab
      pickerWindow = window.open(data.pickerUri, 'google-picker', 'width=800,height=600');

      // Poll for completion
      pollPickerSession();
    }).catch(function(err) {
      console.error('[app] Picker error:', err);
      loading.querySelector('.loading-text').textContent = 'Failed to open picker. Tap to retry.';
      loading.addEventListener('click', function retry() {
        loading.removeEventListener('click', retry);
        openGooglePicker();
      }, { once: true });
    });
  }

  function pollPickerSession() {
    clearTimeout(pickerPollTimer);

    fetch('/api/google/picker/done', { method: 'POST' }).then(function(res) {
      if (!res.ok) throw new Error('Poll failed');
      return res.json();
    }).then(function(data) {
      if (data.ready) {
        // Photos picked successfully
        if (pickerWindow && !pickerWindow.closed) {
          pickerWindow.close();
        }
        pickerWindow = null;
        console.log('[app] Picked ' + data.count + ' photos');
        startSlideshow();
      } else {
        // Not done yet, poll again in 2 seconds
        pickerPollTimer = setTimeout(pollPickerSession, 2000);
      }
    }).catch(function(err) {
      console.warn('[app] Picker poll error:', err.message);
      // Keep polling — user might still be picking
      pickerPollTimer = setTimeout(pollPickerSession, 3000);
    });
  }

  // ===== Start Slideshow (shared between sources) =====
  function startSlideshow() {
    loading.classList.remove('hidden');
    loading.querySelector('.loading-text').textContent = 'Loading photos...';

    return fetchSettings().then(function(savedSettings) {
      if (savedSettings) {
        Object.assign(settings, savedSettings);
      }
      applySettingsToUI();
      return fetchSlides();
    }).then(function(loadedSlides) {
      slides = loadedSlides;

      if (slides.length === 0) {
        loading.querySelector('.loading-text').textContent = 'No photos found.';
        return;
      }

      buildShuffleOrder();
      shuffleIndex = 0;

      loading.classList.add('hidden');

      acquireWakeLock();

      showNext();
    });
  }

  // ===== Init =====
  function init() {
    // Check URL params for OAuth callback
    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('source') === 'google') {
      source = 'google';
      localStorage.setItem('frameflow_source', 'google');
      window.history.replaceState({}, '', '/');
    }
    if (urlParams.get('error')) {
      alert('Google auth error: ' + urlParams.get('error'));
      window.history.replaceState({}, '', '/');
    }

    // If no source selected, show picker
    if (!source) {
      showSourcePicker();
      return;
    }

    // If google source, check auth and start slideshow or pick photos
    if (source === 'google') {
      checkGoogleStatus().then(function(status) {
        if (!status.authenticated) {
          showSourcePicker();
          return;
        }
        if (status.hasPickedPhotos) {
          startSlideshow();
        } else {
          openGooglePicker();
        }
      });
      return;
    }

    // Local source - start directly
    startSlideshow();
  }

  // Source picker buttons
  document.getElementById('src-local').addEventListener('click', function() { selectSource('local'); });
  document.getElementById('src-google').addEventListener('click', function() { selectSource('google'); });

  // Pick new photos button (in settings, only visible for Google source)
  var btnPickPhotos = document.getElementById('btn-pick-photos');
  if (btnPickPhotos) {
    btnPickPhotos.addEventListener('click', function() {
      settingsPanel.classList.add('hidden');
      clearTimeout(timer);
      openGooglePicker();
    });
  }

  // Change source button
  document.getElementById('btn-change-source').addEventListener('click', function() {
    clearTimeout(timer);
    settings.paused = true;
    settingsPanel.classList.add('hidden');
    source = null;
    localStorage.removeItem('frameflow_source');
    showSourcePicker();
  });

  // Start
  init();
})();
