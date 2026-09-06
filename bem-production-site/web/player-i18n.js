// Player-page language only. Wallet state and the Chinese admin are independent.
const LANGUAGE_KEY = "bem2075-player-language";
const SUPPORTED = new Set(["zh", "en"]);
let language = "zh";
try {
  const saved = localStorage.getItem(LANGUAGE_KEY);
  if (SUPPORTED.has(saved)) language = saved;
} catch { /* Language switching remains available without browser storage. */ }

let initialized = false;
const originalAttributes = new WeakMap();
const knownCopy = new Map();
const MAX_KNOWN_STRINGS = 4096;

export const getLanguage = () => language;
export const getLocale = () => language === "en" ? "en-US" : "zh-CN";

function interpolate(text, params) {
  return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
}

export function t(zh, en, params = {}) {
  const localizedParams = target => Object.fromEntries(Object.entries(params).map(([key, value]) =>
    [key, typeof value === "string" ? knownCopy.get(value)?.[target] ?? value : value]));
  const pair = { zh: interpolate(zh, localizedParams("zh")), en: interpolate(en ?? zh, localizedParams("en")) };
  // Retain exact rendered pairs for notices that should survive a language switch.
  for (const text of [pair.zh, pair.en]) {
    knownCopy.delete(text);
    knownCopy.set(text, pair);
  }
  while (knownCopy.size > MAX_KNOWN_STRINGS) knownCopy.delete(knownCopy.keys().next().value);
  return pair[language];
}

export function translateKnown(text, target = language) {
  const value = String(text ?? "");
  return knownCopy.get(value)?.[SUPPORTED.has(target) ? target : language] ?? value;
}

function original(element, name, read) {
  let attributes = originalAttributes.get(element);
  if (!attributes) { attributes = new Map(); originalAttributes.set(element, attributes); }
  if (!attributes.has(name)) attributes.set(name, read());
  return attributes.get(name);
}

export function applyStaticLanguage() {
  document.documentElement.lang = getLocale();
  document.title = t("2075 开奖终端 · BNB 主网", "2075 Draw Terminal · BNB Mainnet");
  document.querySelectorAll("[data-en]").forEach(element => {
    // Never replace a parent holding live amounts, record counts or controls.
    if (element.children.length) return;
    const zh = original(element, "text", () => element.textContent);
    element.textContent = language === "en" ? element.getAttribute("data-en") : zh;
  });
  for (const attribute of ["aria-label", "title", "placeholder", "aria-description"]) {
    const marker = `data-en-${attribute}`;
    document.querySelectorAll(`[${marker}]`).forEach(element => {
      const zh = original(element, attribute, () => element.getAttribute(attribute));
      const value = language === "en" ? element.getAttribute(marker) : zh;
      if (value === null) element.removeAttribute(attribute);
      else element.setAttribute(attribute, value);
    });
  }
  for (const option of SUPPORTED) {
    const button = document.getElementById(`language-${option}`);
    button?.setAttribute("aria-pressed", String(language === option));
  }
}

export function setLanguage(next) {
  if (!SUPPORTED.has(next) || next === language) return;
  language = next;
  try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* Optional preference only. */ }
  applyStaticLanguage();
  window.dispatchEvent(new CustomEvent("bem:languagechange", { detail: { language, locale: getLocale() } }));
}

export function initLanguage() {
  if (initialized) return;
  initialized = true;
  // Capture Chinese first, even when a returning visitor prefers English.
  applyStaticLanguage();
  for (const option of SUPPORTED) {
    document.getElementById(`language-${option}`)?.addEventListener("click", () => setLanguage(option));
  }
}
