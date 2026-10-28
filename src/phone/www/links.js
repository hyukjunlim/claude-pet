'use strict';

// Where a tap goes, for the phone page's rows (app.js) and the page a notification opens (sw.js)
// alike: the app view.js's `open` names, at its page. On Android the link names the app, and
// Android falls back to the web page when it isn't installed; elsewhere it's the web address,
// which the app takes if it's installed. Either way only a tap on the link itself opens the app.

(() => {
  const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', learningx: 'LearningX' };
  // The site each app opens at; an address anywhere else gets no link.
  const SITES = { claude: 'claude.ai', chatgpt: 'chatgpt.com', gemini: 'gemini.google.com', learningx: 'myetl.snu.ac.kr' };
  // The apps' Android packages. LearningX Student 2.0 is the one on Google Play (Xinics).
  const PACKAGES = {
    claude: 'com.anthropic.claude',
    chatgpt: 'com.openai.chatgpt',
    gemini: 'com.google.android.apps.bard',
    learningx: 'com.instructure.candroid.xinics2.production',
  };
  // eTL's own pages don't open LearningX (it's Canvas Student underneath, which takes no https
  // links to eTL); it takes the same address under Canvas Student's scheme instead.
  const SCHEMES = { learningx: 'canvas-courses' };
  const ANDROID = /Android/i.test(self.navigator.userAgent);

  function hrefOf(open) {
    let u;
    try {
      u = new URL(open?.url);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || u.host !== SITES[open.app]) return null;
    if (!ANDROID) return u.href;
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${SCHEMES[open.app] || 'https'};package=${PACKAGES[open.app]};`
      + `S.browser_fallback_url=${encodeURIComponent(u.href)};end`;
  }

  const appName = (app) => NAMES[app] || null;

  self.phoneLinks = { hrefOf, appName };
})();
