const fileInput = document.getElementById('fileInput');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const rateInput = document.getElementById('rateInput');
const rateValue = document.getElementById('rateValue');
const voiceSelect = document.getElementById('voiceSelect');
const refreshVoicesBtn = document.getElementById('refreshVoicesBtn');
const voiceHelp = document.getElementById('voiceHelp');
const librarySelect = document.getElementById('librarySelect');
const bookStatus = document.getElementById('bookStatus');
const bookTitleElement = document.getElementById('bookTitle');
const readingPosition = document.getElementById('readingPosition');
const progressBar = document.getElementById('progressBar');
const progressTrack = document.querySelector('.progress-track');
const progressLabel = document.getElementById('progressLabel');
const appMessage = document.getElementById('appMessage');
const content = document.getElementById('content');
const chapterNav = document.getElementById('chapterNav');
const chapterList = document.getElementById('chapterList');
const chapterSearch = document.getElementById('chapterSearch');
const toggleChaptersBtn = document.getElementById('toggleChaptersBtn');
const prevChapterBtn = document.getElementById('prevChapterBtn');
const nextChapterBtn = document.getElementById('nextChapterBtn');
const rewindBtn = document.getElementById('rewindBtn');
const forwardBtn = document.getElementById('forwardBtn');
const fontSizeInput = document.getElementById('fontSizeInput');
const lineHeightInput = document.getElementById('lineHeightInput');
const contentWidthInput = document.getElementById('contentWidthInput');
const themeSelect = document.getElementById('themeSelect');

let chapters = [];
let selectedChapterIndex = 0;
let currentBookId = '';
let currentBookTitle = '';
let currentBookProgress = { chapterIndex: 0, offset: 0 };
let bookLanguage = 'zh-CN';
let speechChunks = [];
let speechChunkStarts = [];
let speechCharacterMap = [];
let speechIndex = 0;
let playbackOffset = 0;
let utterance = null;
let speechPaused = false;
let isSpeechActive = false;
let speechSession = 0;
let activeSpeechChunk = null;
let availableVoices = [];
let progressSaveTimer = 0;
let databasePromise;

const databaseName = 'audiobook-reader';
const settingsStorageKey = 'audiobook-reader-settings';

function openBookDatabase() {
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('This browser does not support a persistent book library.'));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = function () {
      const database = request.result;
      if (!database.objectStoreNames.contains('books')) {
        database.createObjectStore('books', { keyPath: 'id' });
      }
    };
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      databasePromise = null;
      reject(request.error || new Error('The book library could not be opened.'));
    };
  });

  return databasePromise;
}

async function requestBookStore(mode, callback) {
  const database = await openBookDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('books', mode);
    const store = transaction.objectStore('books');
    let request;
    try {
      request = callback(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = function () {
      resolve(request?.result);
    };
    transaction.onerror = transaction.onabort = function () {
      reject(transaction.error || new Error('The book library could not be updated.'));
    };
    if (request) {
      request.onerror = function () {
        reject(request.error || new Error('The book library request failed.'));
      };
    }
  });
}

function createBookId(name, text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${name}:${text.length}:${(hash >>> 0).toString(16)}`;
}

async function saveCurrentBook() {
  if (!currentBookId || chapters.length === 0) return;
  await requestBookStore('readwrite', (store) => store.put({
    id: currentBookId,
    title: currentBookTitle,
    language: bookLanguage,
    chapters,
    progress: currentBookProgress,
    updatedAt: Date.now()
  }));
}

function persistProgress() {
  clearTimeout(progressSaveTimer);
  progressSaveTimer = window.setTimeout(() => {
    saveCurrentBook().catch((error) => {
      appMessage.textContent = `Could not save reading progress: ${error.message}`;
    });
  }, 350);
}

function calculateProgress(chapterIndex = selectedChapterIndex, offset = currentBookProgress.offset) {
  const totalLength = chapters.reduce((total, chapter) => total + chapter.text.length, 0);
  if (!totalLength) return 0;
  const completedLength = chapters.slice(0, chapterIndex)
    .reduce((total, chapter) => total + chapter.text.length, 0);
  const currentLength = chapters[chapterIndex]?.text.length || 0;
  return Math.max(0, Math.min(100, Math.round((completedLength + Math.min(offset, currentLength)) / totalLength * 100)));
}

function updateBookStatus() {
  if (!chapters.length) {
    bookStatus.hidden = true;
    return;
  }
  bookStatus.hidden = false;
  bookTitleElement.textContent = currentBookTitle;
  const percent = calculateProgress();
  const chapter = chapters[selectedChapterIndex];
  readingPosition.textContent = `Chapter ${selectedChapterIndex + 1} of ${chapters.length} · ${chapter.title}`;
  progressBar.style.width = `${percent}%`;
  progressTrack.setAttribute('aria-valuenow', String(percent));
  progressLabel.textContent = `${percent}%`;
  const hasBook = Boolean(currentBookId);
  playBtn.disabled = !hasBook;
  pauseBtn.disabled = !hasBook || !isSpeechActive || speechPaused;
  stopBtn.disabled = !hasBook;
  prevChapterBtn.disabled = !hasBook || selectedChapterIndex === 0;
  nextChapterBtn.disabled = !hasBook || selectedChapterIndex >= chapters.length - 1;
  rewindBtn.disabled = !hasBook;
  forwardBtn.disabled = !hasBook;
}

function setPlaybackButtons(state = 'stopped') {
  isSpeechActive = state !== 'stopped';
  playBtn.textContent = state === 'playing' ? 'Playing…' : state === 'paused' ? 'Resume' : 'Play';
  playBtn.setAttribute('aria-pressed', String(state === 'playing'));
  pauseBtn.textContent = state === 'paused' ? 'Paused' : 'Pause';
  pauseBtn.setAttribute('aria-pressed', String(state === 'paused'));
  pauseBtn.disabled = state !== 'playing';
}

function loadReadingSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}');
    if (settings.fontSize) fontSizeInput.value = settings.fontSize;
    if (settings.lineHeight) lineHeightInput.value = settings.lineHeight;
    if (settings.contentWidth) contentWidthInput.value = settings.contentWidth;
    if (['dark', 'light', 'sepia'].includes(settings.theme)) themeSelect.value = settings.theme;
  } catch (error) {
    appMessage.textContent = `Could not load reading settings: ${error.message}`;
  }
  applyReadingSettings();
}

function applyReadingSettings() {
  const fontSize = Number(fontSizeInput.value);
  const lineHeight = Number(lineHeightInput.value);
  const contentWidth = Number(contentWidthInput.value);
  document.documentElement.style.setProperty('--content-width', `${contentWidth}px`);
  content.style.setProperty('--reader-font-size', `${fontSize}px`);
  content.style.setProperty('--reader-line-height', String(lineHeight));
  fontSizeInput.nextElementSibling.textContent = `${fontSize}px`;
  lineHeightInput.nextElementSibling.textContent = lineHeight.toFixed(1);
  contentWidthInput.nextElementSibling.textContent = `${contentWidth}px`;
  document.body.dataset.theme = themeSelect.value;

  try {
    localStorage.setItem(settingsStorageKey, JSON.stringify({
      fontSize,
      lineHeight,
      contentWidth,
      theme: themeSelect.value
    }));
  } catch (error) {
    appMessage.textContent = `Could not save reading settings: ${error.message}`;
  }
}

function refreshSpeechVoices() {
  let savedVoiceURI = '';
  try {
    savedVoiceURI = localStorage.getItem('audiobook-reader-voice') || '';
  } catch (error) {
    appMessage.textContent = `Could not load voice settings: ${error.message}`;
  }
  const currentVoiceURI = voiceSelect.value || savedVoiceURI;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) {
    voiceSelect.replaceChildren(new Option('No system voices available', ''));
    voiceSelect.disabled = true;
    voiceHelp.textContent = 'Install or enable voices in your operating system or browser.';
    availableVoices = [];
    return;
  }

  const language = bookLanguage.toLowerCase().split('-')[0];
  const matchingVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language));
  const chineseVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith('zh'));
  const localizedChoices = language === 'zh'
    ? chineseVoices
    : matchingVoices.length > 0 ? matchingVoices : voices;
  const getVoicePreference = (voice) => /语舒|美嘉/i.test(voice.name) ? 0
    : /婷婷|li[- ]?mu/i.test(voice.name) ? 1
      : /xiaoxiao|yunxi/i.test(voice.name) ? 2 : 3;
  const noveltyVoicePattern = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
  const sortedChoices = [...localizedChoices].sort((first, second) => {
    const firstExactLanguage = first.lang.toLowerCase() === bookLanguage.toLowerCase();
    const secondExactLanguage = second.lang.toLowerCase() === bookLanguage.toLowerCase();
    if (firstExactLanguage !== secondExactLanguage) return firstExactLanguage ? -1 : 1;
    if (first.default !== second.default) return first.default ? -1 : 1;
    const preferenceDifference = getVoicePreference(first) - getVoicePreference(second);
    if (preferenceDifference !== 0) return preferenceDifference;
    const firstNovelty = noveltyVoicePattern.test(first.name);
    const secondNovelty = noveltyVoicePattern.test(second.name);
    if (firstNovelty !== secondNovelty) return firstNovelty ? 1 : -1;
    return 0;
  });
  const choices = sortedChoices.slice(0, 2);
  availableVoices = choices;

  voiceSelect.replaceChildren(...choices.map((voice, index) =>
    new Option(`Voice ${index + 1}: ${getVoiceLanguageLabel(voice.lang)}`, voice.voiceURI)
  ));
  voiceSelect.disabled = choices.length < 2;

  if (choices.some((voice) => voice.voiceURI === currentVoiceURI)) {
    voiceSelect.value = currentVoiceURI;
  } else if (choices.length > 0) {
    voiceSelect.selectedIndex = 0;
  }

  if (choices.length < 2) {
    voiceHelp.textContent = 'Only one system voice is available, so a second distinct voice cannot be selected.';
  } else {
    const selectedVoice = getSelectedVoice();
    voiceHelp.textContent = selectedVoice
      ? `Using ${getVoiceLanguageLabel(selectedVoice.lang)}.`
      : 'Choose a system voice; the change takes effect from the next spoken segment.';
  }
  saveCurrentSettings();
}

function getSelectedVoice() {
  return availableVoices.find((voice) => voice.voiceURI === voiceSelect.value) || null;
}

function getVoiceLanguageLabel(language) {
  const normalizedLanguage = language.toLowerCase();
  if (normalizedLanguage === 'zh-cn' || normalizedLanguage === 'zh-sg') return 'Simplified Chinese';
  if (normalizedLanguage === 'zh-tw' || normalizedLanguage === 'zh-hk') return 'Traditional Chinese';
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    return displayNames.of(language) || language;
  } catch {
    return language;
  }
}

window.speechSynthesis.addEventListener('voiceschanged', refreshSpeechVoices);
refreshVoicesBtn.addEventListener('click', function () {
  window.speechSynthesis.getVoices();
  refreshSpeechVoices();
});
refreshSpeechVoices();

function getElementsByLocalName(element, name) {
  return Array.from(element.getElementsByTagNameNS('*', name));
}

function parseXml(xmlText, description) {
  const document = new DOMParser().parseFromString(xmlText, 'application/xml');

  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new Error(`The EPUB ${description} could not be read.`);
  }

  return document;
}

function resolveArchivePath(basePath, href) {
  const cleanHref = decodeURIComponent(href.split(/[?#]/, 1)[0]);
  const parts = cleanHref.startsWith('/') ? [] : basePath.split('/').filter(Boolean);

  for (const part of cleanHref.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }

  return parts.join('/');
}

function extractXhtmlText(xhtml, fragment = '', endFragment = '') {
  const parsedDocument = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
  const body = parsedDocument.querySelector('body') || parsedDocument.documentElement;

  if (parsedDocument.getElementsByTagName('parsererror').length > 0) {
    throw new Error('A chapter in this EPUB could not be read.');
  }

  const blockTags = new Set([
    'address', 'article', 'blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'p', 'section', 'tr'
  ]);

  function collectText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return Array.from(node.childNodes, collectText).join('');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tagName = node.localName.toLowerCase();
    if (['script', 'style', 'svg', 'nav'].includes(tagName)) return '';
    if (tagName === 'br') return '\n';

    const text = Array.from(node.childNodes, collectText).join('');
    return blockTags.has(tagName) ? `\n${text}\n` : text;
  }

  function findFragmentNode(fragmentId) {
    if (!fragmentId) return null;
    const id = decodeURIComponent(fragmentId);
    const target = parsedDocument.getElementById(id);
    if (!target) return null;
    return target.closest('section, article, h1, h2, h3, h4, h5, h6') || target;
  }

  const startNode = findFragmentNode(fragment);
  const endNode = findFragmentNode(endFragment);
  let textRoot = body;
  if (startNode) {
    const range = parsedDocument.createRange();
    range.setStartBefore(startNode);
    if (endNode && endNode !== startNode) {
      range.setEndBefore(endNode);
    } else {
      range.setEndAfter(body.lastChild || body);
    }
    textRoot = range.cloneContents();
  } else if (endNode) {
    const range = parsedDocument.createRange();
    range.setStart(body, 0);
    range.setEndBefore(endNode);
    textRoot = range.cloneContents();
  }

  const heading = (startNode?.matches('h1, h2, h3, h4, h5, h6') ? startNode : null)
    || parsedDocument.querySelector('h1, h2, h3')
    || parsedDocument.querySelector('title');
  const text = collectText(textRoot)
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    title: heading?.textContent.trim() || '',
    text
  };
}

function parseEpubNavigation(xhtml) {
  const document = parseXml(xhtml, 'navigation document');
  const nav = Array.from(document.getElementsByTagNameNS('*', 'nav'))
    .find((element) =>
      (element.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')
        .split(/\s+/).includes('toc')
    );
  const toc = nav || Array.from(document.getElementsByTagNameNS('*', 'nav'))[0];
  if (!toc) return [];

  function parseList(list, level = 0) {
    return Array.from(list.children)
      .filter((child) => child.localName.toLowerCase() === 'li')
      .flatMap((item) => {
        const link = Array.from(item.children)
          .find((child) => child.localName.toLowerCase() === 'a');
        const nestedList = Array.from(item.children)
          .find((child) => ['ol', 'ul'].includes(child.localName.toLowerCase()));
        const entries = [];

        if (link) {
          entries.push({
            title: link.textContent.trim(),
            href: link.getAttribute('href') || '',
            level
          });
        }
        if (nestedList) entries.push(...parseList(nestedList, level + (link ? 1 : 0)));
        return entries;
      });
  }

  const list = Array.from(toc.children)
    .find((child) => ['ol', 'ul'].includes(child.localName.toLowerCase()));
  return list ? parseList(list) : [];
}

function parseEpubNcx(xmlText) {
  const document = parseXml(xmlText, 'navigation control file');
  const navMap = getElementsByLocalName(document, 'navMap')[0];
  if (!navMap) return [];

  function parsePoints(parent, level = 0) {
    return Array.from(parent.children)
      .filter((child) => child.localName.toLowerCase() === 'navpoint')
      .flatMap((point) => {
        const label = getElementsByLocalName(point, 'navLabel')[0];
        const source = getElementsByLocalName(point, 'content')[0]?.getAttribute('src') || '';
        const entries = source ? [{
          title: label?.textContent.trim() || '',
          href: source,
          level
        }] : [];
        entries.push(...parsePoints(point, level + (source ? 1 : 0)));
        return entries;
      });
  }

  return parsePoints(navMap);
}

function isFrontMatterTitle(title) {
  return /^(?:contents?|table of contents|目录|封面|cover|cover image|title page|版权页|版权信息)$/i
    .test(title.trim());
}

function isFrontMatterPath(path) {
  const filename = decodeURIComponent(path.split('/').pop() || '').replace(/\.[^.]+$/, '');
  return /^(?:contents?|toc|cover|coverpage|titlepage|copyright|版权页|版权信息)$/i.test(filename);
}

function splitTextIntoChapters(text) {
  const lines = text.split(/\r?\n/);
  const headingPattern = /^\s*(?:#{1,3}\s*)?(第\s*[〇零一二三四五六七八九十百千万\d]+\s*[章节回卷部篇].*|[（(]\s*[〇零一二三四五六七八九十百千万\d]+\s*[）)](?:\s*.*)?|(?:序章|序言|前言|楔子|引子|尾声|后记|终章|番外(?:篇|章)?)(?:\s+.*)?|(?:Chapter|Prologue|Epilogue|Introduction|Preface)\s*(?:\d+|[IVXLCDM]+)?\s*[:：.\-]?.*)\s*$/i;
  const headings = [];

  lines.forEach((line, index) => {
    const match = line.match(headingPattern);
    if (match) headings.push({ index, title: match[1].trim() });
  });

  if (headings.length === 0) {
    return text.trim() ? [{ title: 'Full Text', text: text.trim() }] : [];
  }

  const result = [];
  const preface = lines.slice(0, headings[0].index).join('\n').trim();
  if (preface) result.push({ title: 'Preface', text: preface });

  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.index ?? lines.length;
    const chapterText = lines.slice(heading.index, end).join('\n').trim();
    if (chapterText) result.push({ title: heading.title, text: chapterText });
  });

  return result;
}

function getSpeechChunks(text, maxLength = 1200) {
  const sentences = text.match(/[^。！？.!?\n]+[。！？.!?\n]*/g) || [text];
  const chunks = [];
  let current = '';

  for (let sentence of sentences) {
    while (sentence.length > maxLength) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }

      let splitAt = sentence.lastIndexOf(' ', maxLength);
      if (splitAt < 1) splitAt = maxLength;
      chunks.push(sentence.slice(0, splitAt).trim());
      sentence = sentence.slice(splitAt).trimStart();
    }

    if (current.length + sentence.length > maxLength && current) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function removeBracketedText(text) {
  const openingBrackets = new Map([
    ['(', ')'], ['（', '）'], ['[', ']'], ['【', '】'], ['〔', '〕'],
    ['{', '}'], ['｛', '｝'], ['<', '>'], ['〈', '〉'], ['《', '》'],
    ['「', '」'], ['『', '』'], ['〖', '〗'], ['〘', '〙'], ['〚', '〛'],
    ['«', '»'], ['‹', '›']
  ]);
  const closingBrackets = new Set(openingBrackets.values());
  const expectedClosers = [];
  const spokenCharacters = [];
  const characterMap = [];

  for (let sourceIndex = 0; sourceIndex < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(sourceIndex));
    const nextIndex = sourceIndex + character.length;

    if (openingBrackets.has(character)) {
      expectedClosers.push(openingBrackets.get(character));
    } else if (expectedClosers.at(-1) === character) {
      expectedClosers.pop();
    } else if (!expectedClosers.length && !closingBrackets.has(character)) {
      spokenCharacters.push(character);
      for (let offset = 0; offset < character.length; offset += 1) {
        characterMap.push(sourceIndex + offset);
      }
    }

    sourceIndex = nextIndex;
  }

  return { text: spokenCharacters.join(''), characterMap };
}

async function readEpub(file) {
  if (!window.JSZip) {
    throw new Error('The EPUB reader could not load. Check your internet connection and reload the page.');
  }

  const archive = await JSZip.loadAsync(file);
  const containerFile = archive.file('META-INF/container.xml');
  if (!containerFile) throw new Error('This file is not a valid EPUB book.');

  const containerDocument = parseXml(await containerFile.async('text'), 'container file');
  const rootfile = getElementsByLocalName(containerDocument, 'rootfile')[0];
  const packagePath = rootfile && rootfile.getAttribute('full-path');
  const packageFile = packagePath && archive.file(packagePath);
  if (!packageFile) throw new Error('The EPUB book package could not be found.');

  const packageDocument = parseXml(await packageFile.async('text'), 'book package');
  const metadataTitle = getElementsByLocalName(packageDocument, 'title')[0]?.textContent.trim();
  const packageDirectory = packagePath.includes('/')
    ? packagePath.slice(0, packagePath.lastIndexOf('/'))
    : '';
  const manifest = new Map();

  for (const item of getElementsByLocalName(packageDocument, 'item')) {
    manifest.set(item.getAttribute('id'), item);
  }

  const languageElement = getElementsByLocalName(packageDocument, 'language')[0];
  bookLanguage = languageElement?.textContent.trim() || 'zh-CN';

  const spine = getElementsByLocalName(packageDocument, 'spine')[0];
  if (!spine) throw new Error('The EPUB book has no readable chapter list.');

  const spineItems = [];
  const spinePaths = new Set();
  const coverIds = new Set(
    getElementsByLocalName(packageDocument, 'meta')
      .filter((meta) => meta.getAttribute('name') === 'cover')
      .map((meta) => meta.getAttribute('content'))
  );
  const coverPaths = new Set(
    getElementsByLocalName(packageDocument, 'reference')
      .filter((reference) => reference.getAttribute('type') === 'cover')
      .map((reference) => resolveArchivePath(packageDirectory, reference.getAttribute('href') || ''))
  );
  const tocId = spine.getAttribute('toc');

  for (const reference of getElementsByLocalName(spine, 'itemref')) {
    const item = manifest.get(reference.getAttribute('idref'));
    if (!item) continue;

    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') || '';
    if (!href || (!mediaType.includes('html') && !/\.x?html?$/i.test(href))) continue;

    const properties = (item.getAttribute('properties') || '').split(/\s+/);
    if (properties.includes('nav') || properties.includes('cover-image') || coverIds.has(item.id)) continue;

    const path = resolveArchivePath(packageDirectory, href);
    if (coverPaths.has(path)) continue;
    spinePaths.add(path);
    spineItems.push({ id: item.id, href, path });
  }

  const xhtmlByPath = new Map();
  for (const spineItem of spineItems) {
    const chapterFile = archive.file(spineItem.path);
    if (!chapterFile) continue;
    xhtmlByPath.set(spineItem.path, await chapterFile.async('text'));
  }

  let navigation = [];
  const navItem = Array.from(manifest.values()).find((item) =>
    (item.getAttribute('properties') || '').split(/\s+/).includes('nav')
  );
  if (navItem) {
    const navPath = resolveArchivePath(packageDirectory, navItem.getAttribute('href'));
    const navFile = archive.file(navPath);
    if (navFile) navigation = parseEpubNavigation(await navFile.async('text'));
  }

  if (navigation.length === 0 && tocId) {
    const ncxItem = manifest.get(tocId);
    const ncxPath = ncxItem && resolveArchivePath(packageDirectory, ncxItem.getAttribute('href'));
    const ncxFile = ncxPath && archive.file(ncxPath);
    if (ncxFile) navigation = parseEpubNcx(await ncxFile.async('text'));
  }

  const epubChapters = [];
  if (navigation.length > 0) {
    const resolvedNavigation = navigation.map((entry) => {
      const [entryPath, fragment = ''] = entry.href.split('#', 2);
      const path = resolveArchivePath(packageDirectory, entryPath);
      return { ...entry, path, fragment };
    });

    for (let index = 0; index < resolvedNavigation.length; index += 1) {
      const entry = resolvedNavigation[index];
      if (!entry.title || isFrontMatterTitle(entry.title) || isFrontMatterPath(entry.path)
        || !spinePaths.has(entry.path)) continue;

      const xhtml = xhtmlByPath.get(entry.path);
      if (!xhtml) continue;
      const nextSameFileEntry = resolvedNavigation
        .slice(index + 1)
        .find((candidate) => candidate.path === entry.path);
      const chapter = extractXhtmlText(xhtml, entry.fragment, nextSameFileEntry?.fragment);
      if (chapter.text) {
        epubChapters.push({
          title: entry.title,
          text: chapter.text,
          level: entry.level
        });
      }
    }
  }

  if (epubChapters.length === 0) {
    for (const spineItem of spineItems) {
      const xhtml = xhtmlByPath.get(spineItem.path);
      if (!xhtml) continue;
      const chapter = extractXhtmlText(xhtml);
      if (chapter.text) {
        if (isFrontMatterPath(spineItem.path)) continue;
        const fallbackTitle = decodeURIComponent(spineItem.href.split('/').pop()).replace(/\.[^.]+$/, '');
        const title = chapter.title || fallbackTitle || `Chapter ${epubChapters.length + 1}`;
        if (isFrontMatterTitle(title)) continue;
        epubChapters.push({
          title,
          text: chapter.text,
          level: 0
        });
      }
    }
  }

  if (epubChapters.length === 0) {
    throw new Error('No readable text chapters were found in this EPUB.');
  }

  return {
    title: metadataTitle || file.name.replace(/\.[^.]+$/, ''),
    language: bookLanguage,
    chapters: epubChapters
  };
}

function renderChapterList() {
  chapterNav.hidden = chapters.length === 0;
  chapterNav.parentElement.classList.toggle('has-chapters', chapters.length > 0);
  chapterList.replaceChildren();

  const roots = [];
  const parents = [];
  chapters.forEach((chapter, index) => {
    const node = { chapter, index, children: [] };
    const level = Math.max(0, chapter.level || 0);
    while (parents.length > level) parents.pop();
    if (level > 0 && parents[level - 1]) parents[level - 1].children.push(node);
    else roots.push(node);
    parents[level] = node;
  });

  function createNode(node) {
    const wrapper = document.createElement('div');
    wrapper.className = 'chapter-node';
    wrapper.dataset.chapterIndex = String(node.index);
    const entry = document.createElement('div');
    entry.className = 'chapter-entry';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chapter-item';
    button.textContent = `${node.index + 1}. ${node.chapter.title}`;
    button.title = node.chapter.title;
    if (node.index === selectedChapterIndex) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => selectChapter(node.index));
    entry.append(button);

    if (node.children.length > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'chapter-toggle';
      toggle.textContent = '−';
      toggle.setAttribute('aria-label', `Collapse subchapters for ${node.chapter.title}`);
      toggle.setAttribute('aria-expanded', 'true');
      toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        toggle.textContent = expanded ? '+' : '−';
        wrapper.classList.toggle('is-collapsed', expanded);
        toggle.setAttribute('aria-label', `${expanded ? 'Expand' : 'Collapse'} subchapters for ${node.chapter.title}`);
      });
      entry.append(toggle);
    }

    wrapper.append(entry);
    if (node.children.length > 0) {
      const children = document.createElement('div');
      children.className = 'chapter-children';
      node.children.forEach((child) => children.append(createNode(child)));
      wrapper.append(children);
    }
    return wrapper;
  }

  roots.forEach((node) => chapterList.append(createNode(node)));
  filterChapterList();
  const currentButton = chapterList.querySelector('[aria-current="page"]');
  if (currentButton) {
    let parent = currentButton.closest('.chapter-node')?.parentElement?.closest('.chapter-node');
    while (parent) {
      parent.classList.remove('is-collapsed');
      const toggle = parent.querySelector(':scope > .chapter-entry .chapter-toggle');
      if (toggle) {
        toggle.textContent = '−';
        toggle.setAttribute('aria-expanded', 'true');
      }
      parent = parent.parentElement?.closest('.chapter-node');
    }
    const rect = currentButton.getBoundingClientRect();
    const listRect = chapterList.getBoundingClientRect();
    if (rect.top < listRect.top || rect.bottom > listRect.bottom) {
      chapterList.scrollTop += rect.top - listRect.top - listRect.height / 2 + rect.height / 2;
    }
  }
}

function filterChapterList() {
  const query = chapterSearch.value.trim().toLocaleLowerCase();
  for (const node of chapterList.querySelectorAll('.chapter-node')) {
    const matches = !query || node.querySelector(':scope > .chapter-entry .chapter-item')
      .textContent.toLocaleLowerCase().includes(query);
    const descendantMatches = [...node.querySelectorAll('.chapter-node')].some((child) => {
      const ownButton = child.querySelector(':scope > .chapter-entry .chapter-item');
      return ownButton?.textContent.toLocaleLowerCase().includes(query);
    });
    node.hidden = !matches && !descendantMatches;
    if (query && descendantMatches) node.classList.remove('is-collapsed');
  }
  const empty = chapterList.querySelector('.chapter-empty');
  if (empty) empty.remove();
  if (query && !chapterList.querySelector('.chapter-node:not([hidden])')) {
    const message = document.createElement('div');
    message.className = 'chapter-empty';
    message.textContent = 'No matching chapters';
    chapterList.append(message);
  }
}

function renderChapterText(text) {
  activeSpeechChunk = null;
  content.textContent = text;
}

function getHighlightEnd(text, start, charLength) {
  if (charLength > 0) return Math.min(text.length, start + charLength);

  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(bookLanguage, { granularity: 'word' });
    for (const segment of segmenter.segment(text.slice(start))) {
      if (segment.isWordLike) return start + segment.index + segment.segment.length;
      if (segment.index > 0) break;
    }
  }

  const match = text.slice(start).match(/^[^\s，。！？；：、,.!?;:]+/);
  return start + (match ? match[0].length : 1);
}

function scrollHighlightIntoView(element) {
  const containerRect = content.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const margin = Math.min(content.clientHeight * 0.25, 150);
  if (rect.top < containerRect.top + margin || rect.bottom > containerRect.bottom - margin) {
    content.scrollTop += rect.top - containerRect.top - content.clientHeight / 2 + rect.height / 2;
  }
}

function scrollToTextOffset(offset) {
  const textNode = content.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
  const range = document.createRange();
  range.setStart(textNode, Math.min(offset, textNode.length));
  range.setEnd(textNode, Math.min(offset, textNode.length));
  const rect = range.getBoundingClientRect();
  const containerRect = content.getBoundingClientRect();
  content.scrollTop += rect.top - containerRect.top - content.clientHeight / 2;
}

function updateReadingProgress(offset = currentBookProgress.offset) {
  const chapterLength = chapters[selectedChapterIndex]?.text.length || 0;
  currentBookProgress = {
    chapterIndex: selectedChapterIndex,
    offset: Math.max(0, Math.min(offset, chapterLength))
  };
  updateBookStatus();
  persistProgress();
}

function renderSpeechChunk(index) {
  const text = chapters[selectedChapterIndex].text;
  const chunk = speechChunks[index];
  const chunkStart = speechChunkStarts[index];
  const chunkEnd = chunkStart + chunk.length;
  const sourceIndices = speechCharacterMap.slice(chunkStart, chunkEnd);
  const start = sourceIndices[0];
  const end = sourceIndices[sourceIndices.length - 1] + 1;
  const chunkElement = document.createElement('span');
  chunkElement.className = 'speech-chunk';

  content.replaceChildren(
    document.createTextNode(text.slice(0, start)),
    chunkElement,
    document.createTextNode(text.slice(end))
  );
  chunkElement.textContent = text.slice(start, end);
  activeSpeechChunk = { element: chunkElement, text: chunk, sourceIndices, start };
  scrollHighlightIntoView(chunkElement);
}

function highlightSpeechPosition(charIndex, charLength = 0) {
  if (!activeSpeechChunk) return;

  const start = Math.max(0, Math.min(charIndex, activeSpeechChunk.text.length));
  const end = Math.max(start + 1, getHighlightEnd(activeSpeechChunk.text, start, charLength));
  const displayText = activeSpeechChunk.element.textContent;
  let displayCursor = 0;
  let textCursor = start;
  const fragment = document.createDocumentFragment();
  let firstMark = null;

  while (textCursor < end) {
    let runEnd = textCursor + 1;
    while (runEnd < end
      && activeSpeechChunk.sourceIndices[runEnd] === activeSpeechChunk.sourceIndices[runEnd - 1] + 1) {
      runEnd += 1;
    }

    const sourceStart = activeSpeechChunk.sourceIndices[textCursor] - activeSpeechChunk.start;
    const sourceEnd = activeSpeechChunk.sourceIndices[runEnd - 1] + 1 - activeSpeechChunk.start;
    fragment.append(document.createTextNode(displayText.slice(displayCursor, sourceStart)));

    const mark = document.createElement('mark');
    mark.className = 'spoken-highlight';
    mark.textContent = displayText.slice(sourceStart, sourceEnd);
    fragment.append(mark);
    firstMark ||= mark;
    displayCursor = sourceEnd;
    textCursor = runEnd;
  }

  fragment.append(document.createTextNode(displayText.slice(displayCursor)));
  activeSpeechChunk.element.replaceChildren(fragment);
  if (firstMark) scrollHighlightIntoView(firstMark);
}

function stopSpeech() {
  window.speechSynthesis.cancel();
  speechSession += 1;
  speechPaused = false;
  isSpeechActive = false;
  speechIndex = 0;
  setPlaybackButtons();
  if (chapters.length > 0) renderChapterText(chapters[selectedChapterIndex].text);
}

function selectChapter(index) {
  if (index < 0 || index >= chapters.length) return;
  stopSpeech();
  selectedChapterIndex = index;
  currentBookProgress = { chapterIndex: index, offset: 0 };
  renderChapterText(chapters[index].text);
  renderChapterList();
  chapterSearch.value = '';
  updateBookStatus();
  persistProgress();
}

async function refreshLibrary(selectedId = currentBookId) {
  const books = await requestBookStore('readonly', (store) => store.getAll());
  books.sort((first, second) => second.updatedAt - first.updatedAt);
  librarySelect.replaceChildren(new Option('Choose a book…', ''));
  for (const book of books) {
    librarySelect.add(new Option(book.title, book.id));
  }
  librarySelect.disabled = books.length === 0;
  if (books.some((book) => book.id === selectedId)) librarySelect.value = selectedId;
  return books;
}

async function loadBook(bookId) {
  const book = await requestBookStore('readonly', (store) => store.get(bookId));
  if (!book) throw new Error('This book is no longer in your library. Please import it again.');
  stopSpeech();
  currentBookId = book.id;
  currentBookTitle = book.title;
  chapters = book.chapters;
  bookLanguage = book.language || 'zh-CN';
  currentBookProgress = book.progress || { chapterIndex: 0, offset: 0 };
  selectedChapterIndex = Math.min(currentBookProgress.chapterIndex || 0, chapters.length - 1);
  const currentTextLength = chapters[selectedChapterIndex]?.text.length || 0;
  currentBookProgress.offset = Math.min(currentBookProgress.offset || 0, currentTextLength);
  renderChapterList();
  renderChapterText(chapters[selectedChapterIndex]?.text || '');
  updateBookStatus();
  refreshSpeechVoices();
  scrollToTextOffset(currentBookProgress.offset);
}

function updateSpeechOffset(charIndex) {
  const spokenIndex = speechChunkStarts[speechIndex] + charIndex;
  const sourceIndex = speechCharacterMap[Math.min(spokenIndex, speechCharacterMap.length - 1)];
  if (sourceIndex !== undefined) {
    playbackOffset = sourceIndex + 1;
    updateReadingProgress(playbackOffset);
  }
}

function startSpeechAtOffset(offset) {
  window.speechSynthesis.cancel();
  speechSession += 1;
  speechIndex = 0;
  speechPaused = false;
  playbackOffset = Math.max(0, offset);
  updateReadingProgress(playbackOffset);
  const speechText = removeBracketedText(chapters[selectedChapterIndex].text);
  const spokenStart = speechText.characterMap.findIndex((sourceOffset) => sourceOffset >= playbackOffset);
  const start = spokenStart < 0 ? speechText.text.length : spokenStart;
  const remainingText = speechText.text.slice(start);
  speechChunks = getSpeechChunks(remainingText);
  speechCharacterMap = speechText.characterMap;
  let searchFrom = start;
  speechChunkStarts = speechChunks.map((chunk) => {
    const chunkStart = speechText.text.indexOf(chunk, searchFrom);
    searchFrom = chunkStart + chunk.length;
    return chunkStart;
  });
  if (speechChunks.length === 0) {
    updateReadingProgress(chapters[selectedChapterIndex].text.length);
    setPlaybackButtons();
    return;
  }
  updateBookStatus();
  setPlaybackButtons('playing');
  speakNextChunk(speechSession);
}

rateInput.addEventListener('input', function () {
  const value = Number(rateInput.value);
  rateValue.textContent = value.toFixed(1) + 'x';

  if (utterance) {
    utterance.rate = value;
  }
});

function saveCurrentSettings() {
  const voiceURI = voiceSelect.value;
  if (voiceURI) {
    try {
      localStorage.setItem('audiobook-reader-voice', voiceURI);
    } catch (error) {
      appMessage.textContent = `Could not save voice settings: ${error.message}`;
    }
  }
}

voiceSelect.addEventListener('change', function () {
  saveCurrentSettings();
  const voice = getSelectedVoice();
  if (voice) voiceHelp.textContent = `${getVoiceLanguageLabel(voice.lang)} selected. It will take effect from the next segment.`;
});

rateInput.addEventListener('change', saveCurrentSettings);
chapterSearch.addEventListener('input', filterChapterList);

toggleChaptersBtn.addEventListener('click', function () {
  const collapsed = chapterNav.classList.toggle('is-collapsed');
  toggleChaptersBtn.textContent = collapsed ? 'Expand' : 'Collapse';
  toggleChaptersBtn.setAttribute('aria-expanded', String(!collapsed));
});

for (const input of [fontSizeInput, lineHeightInput, contentWidthInput, themeSelect]) {
  input.addEventListener('input', applyReadingSettings);
  input.addEventListener('change', applyReadingSettings);
}

librarySelect.addEventListener('change', async function () {
  if (!librarySelect.value) return;
  try {
    await loadBook(librarySelect.value);
    appMessage.textContent = `Opened "${currentBookTitle}" and restored your last reading position.`;
  } catch (error) {
    appMessage.textContent = `Could not open book: ${error.message}`;
  }
});

fileInput.addEventListener('change', async function (event) {
  const file = event.target.files[0];

  if (!file) return;

  stopSpeech();
  speechChunks = [];
  chapters = [];
  selectedChapterIndex = 0;
  renderChapterList();
  content.textContent = 'Reading book…';
  appMessage.textContent = 'Importing and saving book…';

  try {
    let title = file.name.replace(/\.[^.]+$/, '');
    if (file.name.toLowerCase().endsWith('.epub')) {
      const epub = await readEpub(file);
      chapters = epub.chapters;
      title = epub.title;
      bookLanguage = epub.language || bookLanguage;
    } else {
      chapters = splitTextIntoChapters(await file.text());
      bookLanguage = 'zh-CN';
    }
    const fullText = chapters.map((chapter) => chapter.text).join('\n');
    currentBookId = createBookId(file.name, fullText);
    currentBookTitle = title;
    currentBookProgress = { chapterIndex: 0, offset: 0 };
    selectedChapterIndex = 0;
    await saveCurrentBook();
    await refreshLibrary(currentBookId);
    try {
      localStorage.setItem('audiobook-reader-last-book', currentBookId);
    } catch (error) {
      appMessage.textContent = `Could not save your recent book: ${error.message}`;
    }
    refreshSpeechVoices();

    if (chapters.length > 0) {
      renderChapterList();
      renderChapterText(chapters[0].text);
      updateBookStatus();
      appMessage.textContent = `"${currentBookTitle}" has been added to your library.`;
    } else {
      content.textContent = 'No readable text was found in this book.';
    }
  } catch (error) {
    appMessage.textContent = `Import failed: ${error.message}`;
    content.textContent = error.message || 'The selected book could not be read.';
  }
});

playBtn.addEventListener('click', function () {
  if (chapters.length === 0) {
    appMessage.textContent = 'Choose a book from your library or import one first.';
    return;
  }

  if (speechPaused) {
    speechPaused = false;
    window.speechSynthesis.resume();
    setPlaybackButtons('playing');
    return;
  }
  startSpeechAtOffset(currentBookProgress.offset);
});

function seekBySeconds(direction) {
  if (!chapters.length) return;
  const chapterText = chapters[selectedChapterIndex].text;
  const charactersPerSecond = /[\u3400-\u9fff]/.test(chapterText) ? 5 : 15;
  const characters = Math.round(charactersPerSecond * 10 * Number(rateInput.value)) * direction;
  const offset = Math.max(0, Math.min(
    chapters[selectedChapterIndex].text.length,
    playbackOffset + characters
  ));
  startSpeechAtOffset(offset);
}

function navigateChapter(index) {
  const resumePlayback = isSpeechActive && !speechPaused;
  if (index < 0 || index >= chapters.length) return;
  selectChapter(index);
  if (resumePlayback) startSpeechAtOffset(0);
}

prevChapterBtn.addEventListener('click', () => navigateChapter(selectedChapterIndex - 1));
nextChapterBtn.addEventListener('click', () => navigateChapter(selectedChapterIndex + 1));
rewindBtn.addEventListener('click', () => seekBySeconds(-1));
forwardBtn.addEventListener('click', () => seekBySeconds(1));

function speakNextChunk(session) {
  if (session !== speechSession || speechPaused || speechIndex >= speechChunks.length) return;

  utterance = new SpeechSynthesisUtterance(speechChunks[speechIndex]);
  utterance.rate = Number(rateInput.value);
  utterance.lang = bookLanguage;
  utterance.voice = getSelectedVoice();
  utterance.onstart = function () {
    if (session !== speechSession) return;
    renderSpeechChunk(speechIndex);
    highlightSpeechPosition(0);
  };
  utterance.onboundary = function (event) {
    if (session !== speechSession || typeof event.charIndex !== 'number') return;
    highlightSpeechPosition(event.charIndex, event.charLength);
    updateSpeechOffset(event.charIndex);
  };
  utterance.onend = function () {
    if (session !== speechSession || speechPaused) return;
    updateSpeechOffset(speechChunks[speechIndex].length);
    speechIndex += 1;
    if (speechIndex >= speechChunks.length) {
      setPlaybackButtons();
      updateReadingProgress(chapters[selectedChapterIndex].text.length);
      return;
    }
    speakNextChunk(session);
  };
  utterance.onerror = function (event) {
    if (session !== speechSession || speechPaused || event.error === 'canceled') return;
    speechSession += 1;
    window.speechSynthesis.cancel();
    speechPaused = false;
    setPlaybackButtons();
    renderChapterText(chapters[selectedChapterIndex].text);
    voiceHelp.textContent = `Reading stopped (${event.error || 'speech error'}). Choose another voice and try again.`;
  };

  window.speechSynthesis.speak(utterance);
}

pauseBtn.addEventListener('click', function () {
  if (isSpeechActive && !speechPaused) {
    speechPaused = true;
    window.speechSynthesis.pause();
    setPlaybackButtons('paused');
  } else if (speechPaused) {
    speechPaused = false;
    window.speechSynthesis.resume();
    setPlaybackButtons('playing');
  }
});

stopBtn.addEventListener('click', function () {
  stopSpeech();
});

async function initializeReader() {
  loadReadingSettings();
  try {
    const books = await refreshLibrary('');
    const lastBookId = localStorage.getItem('audiobook-reader-last-book');
    const initialBook = books.find((book) => book.id === lastBookId) || books[0];
    if (initialBook) {
      await loadBook(initialBook.id);
      librarySelect.value = initialBook.id;
      appMessage.textContent = `Restored your last reading position in "${currentBookTitle}".`;
    }
    const savedVoice = localStorage.getItem('audiobook-reader-voice');
    if (savedVoice && [...voiceSelect.options].some((option) => option.value === savedVoice)) {
      voiceSelect.value = savedVoice;
    }
  } catch (error) {
    appMessage.textContent = `Could not open the library: ${error.message}`;
    librarySelect.disabled = true;
  }
}

librarySelect.addEventListener('change', function () {
  if (!librarySelect.value) return;
  try {
    localStorage.setItem('audiobook-reader-last-book', librarySelect.value);
  } catch (error) {
    appMessage.textContent = `Could not save your recent book: ${error.message}`;
  }
});

window.addEventListener('pagehide', function () {
  clearTimeout(progressSaveTimer);
  if (currentBookId) {
    saveCurrentBook().catch((error) => console.error('Could not save reading progress before leaving:', error));
  }
});

loadReadingSettings();
initializeReader();

const installBtn = document.getElementById('installBtn');
const installHelp = document.getElementById('installHelp');
const offlineStatus = document.getElementById('offlineStatus');
let deferredInstallPrompt = null;

function showInstallInstructions() {
  const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  installHelp.textContent = isAppleMobile
    ? 'In Safari, tap Share, then “Add to Home Screen”.'
    : 'Use your browser menu and choose “Install app” or “Add to Home screen”.';
  installHelp.hidden = false;
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./service-worker.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      offlineStatus.hidden = false;
      if (!window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone) {
        installBtn.hidden = false;
      }
    })
    .catch((error) => {
      offlineStatus.textContent = `Offline setup failed: ${error.message}`;
      offlineStatus.hidden = false;
    });
} else {
  offlineStatus.textContent = 'Offline installation requires an HTTPS website.';
  offlineStatus.hidden = false;
}

window.addEventListener('beforeinstallprompt', function (event) {
  event.preventDefault();
  deferredInstallPrompt = event;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async function () {
  if (!deferredInstallPrompt) {
    showInstallInstructions();
    return;
  }

  try {
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    installHelp.textContent = choice.outcome === 'accepted'
      ? 'Starlight Reader is being installed.'
      : 'Installation was cancelled. You can install it later from your browser menu.';
    installHelp.hidden = false;
    deferredInstallPrompt = null;
  } catch (error) {
    installHelp.textContent = `Could not start installation: ${error.message}`;
    installHelp.hidden = false;
  }
});

window.addEventListener('appinstalled', function () {
  installBtn.hidden = true;
  installHelp.textContent = 'Starlight Reader is installed.';
  installHelp.hidden = false;
});

window.addEventListener('offline', function () {
  offlineStatus.textContent = 'You are offline. The cached reader is available; books remain on this device.';
  offlineStatus.hidden = false;
});

window.addEventListener('online', function () {
  offlineStatus.textContent = 'Offline reading is ready on this device.';
});
