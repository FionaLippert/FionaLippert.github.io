import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(root, name), 'utf8');
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// A deliberately small Markdown subset: headings, paragraphs, links and lists.
// Raw HTML is escaped; links must use HTTPS or mailto.
function inline(text) {
  return escape(text).replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, url) => {
    if (!/^(https:\/\/|mailto:)/.test(url)) throw new Error('Links must use https:// or mailto:');
    return `<a href="${url}">${label}<span aria-hidden="true"> ↗</span></a>`;
  });
}
function markdown(text) {
  return text.trim().split(/\n\s*\n/).filter(Boolean).map(block => {
    const heading = block.match(/^(#{3,4}) (.+)$/);
    if (heading) return `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
    if (block.split('\n').every(line => line.startsWith('- '))) return `<ul>${block.split('\n').map(line => `<li>${inline(line.slice(2))}</li>`).join('')}</ul>`;
    return `<p>${inline(block.replace(/\n/g, ' '))}</p>`;
  }).join('\n');
}
const profile = JSON.parse(read('profile.json'));
if (!['polar', 'botanical', 'earth'].includes(profile.theme)) throw new Error('Unknown theme');
const source = read('content.md');
const title = source.match(/^# (.+)$/m)?.[1];
if (!title) throw new Error('content.md needs a # headline');
const sections = Object.fromEntries([...source.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map(m => [m[1], m[2]]));
for (const key of ['About', 'Research', 'Selected work', 'Connect']) if (!sections[key]?.trim()) throw new Error(`Missing section: ${key}`);
const articles = text => text.trim().split(/(?=^### )/m).filter(Boolean).map((part, i) => `<article><span class="number" aria-hidden="true">0${i + 1}</span><div>${markdown(part)}</div></article>`).join('\n');
const replacements = {
  ...Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, escape(value)])),
  title: escape(title), about: markdown(sections.About), research: articles(sections.Research),
  work: articles(sections['Selected work']), connect: markdown(sections.Connect),
  css: read('style.css')
};
const html = read('template.html').replace(/\{\{(\w+)\}\}/g, (_, key) => {
  if (!(key in replacements)) throw new Error(`Unknown template slot: ${key}`);
  return replacements[key];
});
if (/\{\{\w+\}\}/.test(html)) throw new Error('Unresolved template slot');
writeFileSync(join(root, 'index.html'), html);
console.log(`Built index.html for ${profile.name}`);
