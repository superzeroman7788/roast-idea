import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = path.join(__dirname, "../skills");

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const k = line.slice(0, ci).trim();
    const v = line.slice(ci + 1).trim();
    meta[k] = v;
  }
  return { meta, body: m[2].trimStart() };
}

function stationMatches(stationMeta, station) {
  if (!station || !stationMeta) return true;
  // handles "[produce, agent]" or "produce"
  return stationMeta.replace(/[\[\]]/g, "").split(",").map(s => s.trim()).includes(station);
}

// L1 索引:所有 skill 的 name + description(常驻)
export function listSkills(station) {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(SKILLS_DIR)) {
    const skillFile = path.join(SKILLS_DIR, name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const { meta } = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
    if (station && !stationMatches(meta.station, station)) continue;
    out.push({ name: meta.name || name, description: meta.description || "", station: meta.station || "", kind: meta.kind || "instruction", version: meta.version || "1" });
  }
  return out;
}

// L2 正文:命中 skill 时才加载
export function loadSkill(name) {
  const skillFile = path.join(SKILLS_DIR, name, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  const raw = fs.readFileSync(skillFile, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  // 收集可用的 L3 references 列表
  const refDir = path.join(SKILLS_DIR, name, "references");
  const refs = fs.existsSync(refDir) ? fs.readdirSync(refDir) : [];
  return { name: meta.name || name, meta, body, refs };
}

// L3 参考文件:正文里用到才按需加载
export function loadSkillRef(skillName, refFile) {
  const p = path.join(SKILLS_DIR, skillName, "references", path.basename(refFile));
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

// 关键词路由:找最匹配的 skill
export function routeSkill(task, station) {
  const skills = listSkills(station);
  if (!skills.length) return null;
  const words = (task || "").toLowerCase().split(/\W+/).filter(w => w.length > 3);
  let best = null, bestScore = 0;
  for (const sk of skills) {
    const desc = sk.description.toLowerCase();
    const score = words.filter(w => desc.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = sk; }
  }
  return bestScore >= 2 ? best : null;
}

// 保存新 skill(自动提炼)
export function saveSkill({ name, description, station, body }) {
  const dir = path.join(SKILLS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\nstation: ${station || "produce"}\nkind: instruction\nversion: 1\n---\n\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter + body, "utf8");
  return loadSkill(name);
}
