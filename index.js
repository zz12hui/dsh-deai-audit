/**
 * deai-audit：DSH 对话内工具。
 * 注册两个模型可见工具：
 *   deai_audit        —— 对文案做六维 AI 味评分、逐句打标、给改法
 *   deai_audit_config —— 查看 / 列文体 / 改配置 / 恢复默认
 * 配置读取顺序：DEAI_CONFIG 环境变量 → ~/.dsh/deai-audit-config.json → 包内 config/deai-config.json
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'tool-deai-audit';
export const inject = ['tools'];

const PACKAGE_CONFIG = fileURLToPath(new URL('./config/deai-config.json', import.meta.url));
const USER_CONFIG = join(homedir(), '.dsh', 'deai-audit-config.json');

const FALLBACK = {
  bands: [
    { max: 15, label: '很自然', action: '可交付' },
    { max: 30, label: '基本自然', action: '挑 1-2 处改' },
    { max: 50, label: '有模板感，建议再改', action: '结构性改，别只换词' },
    { max: 100, label: '一眼 AI，必须重写', action: '重写，别修补' },
  ],
  common: {
    templateWords: ['赋能', '闭环', '抓手', '沉淀', '打造', '助力', '驱动'],
    connectors: ['首先', '其次', '此外', '同时', '因此', '综上'],
    colloquial: ['说白了', '其实', '比如', '以前', '现在'],
    concretePattern: '\\d|客户|项目|上线|交付',
    parallelStarts: ['赋能', '打造', '推动', '实现', '通过', '基于'],
    verbStarts: ['负责', '交付', '完成', '对接', '从'],
    skillSections: ['技能与证书'],
    maxSentenceLength: 50,
    triadPattern: '[^，。；：]{2,6}、[^，。；：]{2,6}、[^，。；：]{2,6}',
    uniformBulletThreshold: 0.22,
    uniformPenalty: 35,
    humanPenaltyScale: 300,
    repeatNgram: 6,
    repeatMinCount: 4,
    repeatWeight: 4,
    repeatCap: 60,
  },
  genres: [{
    id: 'resume', name: '简历 / 述职',
    weights: { struct: 30, vague: 20, syntax: 15, concrete: 25, repeat: 10, human: 0 },
    cliche: ['赋能', '闭环', '沉淀'], note: '最怕标签式结构和口号',
  }],
  defaultGenre: 'resume',
};

/* ---------------- 配置 ---------------- */
function deepMerge(base, over) {
  if (Array.isArray(over)) return over;
  if (over && typeof over === 'object') {
    const out = Array.isArray(base) ? [] : { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base ? base[k] : undefined, over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

function configPath() {
  if (process.env.DEAI_CONFIG) return process.env.DEAI_CONFIG;
  return existsSync(USER_CONFIG) ? USER_CONFIG : PACKAGE_CONFIG;
}

function loadConfig() {
  let cfg = JSON.parse(JSON.stringify(FALLBACK));
  const candidates = [PACKAGE_CONFIG];
  const chosen = configPath();
  if (chosen !== PACKAGE_CONFIG) candidates.push(chosen);
  for (const p of candidates) {
    if (p && existsSync(p)) {
      try {
        cfg = deepMerge(cfg, JSON.parse(readFileSync(p, 'utf8')));
      } catch { /* ignore broken config */ }
    }
  }
  if (!Array.isArray(cfg.genres) || cfg.genres.length === 0) cfg.genres = FALLBACK.genres;
  return cfg;
}

function saveUserConfig(cfg) {
  const dir = join(homedir(), '.dsh');
  if (!existsSync(dir)) throw new Error('.dsh 目录不存在');
  writeFileSync(USER_CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
  return USER_CONFIG;
}

/* ---------------- 评分引擎 ---------------- */
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const BULLET_RE = /^[•·-]|^（?\d+[.、)]/;
const LABEL_RE = /^([^：]{1,12})：/;
const SENT_RE = /[。！？；]/;

function splitParas(text) {
  return String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function splitSents(paras) {
  const out = [];
  for (const p of paras) {
    for (const s of p.replace(/^[•·-]\s*/, '').split(SENT_RE)) {
      const t = s.trim();
      if (t.length >= 6) out.push(t);
    }
  }
  return out;
}

function std(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  return [m, Math.sqrt(v)];
}

function isLabel(t, cfg) {
  const m = LABEL_RE.exec(t);
  if (!m) return false;
  if (/\d/.test(m[1])) return false;
  return !cfg.common.verbStarts.some((v) => m[1].startsWith(v));
}

const count = (text, w) => text.split(w).length - 1;

function analyze(paras, genreId, cfg) {
  const prof = cfg.genres.find((g) => g.id === genreId) || cfg.genres[0];
  const c = cfg.common;
  const text = paras.join('');
  const n = text.length || 1;
  const bullets = paras.filter((p) => BULLET_RE.test(p));
  const sents = splitSents(paras);
  const lens = sents.map((s) => s.length);

  let section = '';
  const workBullets = [];
  for (const p of paras) {
    if (p.length <= 8 && !BULLET_RE.test(p)) section = p;
    if (BULLET_RE.test(p) && !(c.skillSections || []).includes(section)) workBullets.push(p);
  }
  const labels = workBullets.filter((b) => isLabel(b.replace(/^[•·-]\s*/, ''), cfg));
  const labelRatio = labels.length / Math.max(1, workBullets.length);
  let runs = 0, run = 1, prev = false;
  for (const b of workBullets) {
    const cur = isLabel(b.replace(/^[•·-]\s*/, ''), cfg);
    run = cur && prev ? run + 1 : 1;
    prev = cur;
  }
  if (run >= 3) runs += 1;
  const parallel = workBullets.filter((b) => (c.parallelStarts || []).some(
    (x) => b.replace(/^[•·-]\s*/, '').startsWith(x),
  )).length;
  let uniformPen = 0;
  if (bullets.length >= 6) {
    const [m, sd] = std(bullets.map((b) => b.length));
    if (m && sd / m < (c.uniformBulletThreshold || 0.22)) uniformPen = c.uniformPenalty || 35;
  }
  const dimStruct = clamp(
    labelRatio * 200 + runs * 12 + parallel / Math.max(1, workBullets.length) * 60 + uniformPen,
  );

  const cliche = [...new Set([...c.templateWords, ...(prof.cliche || [])])];
  const hits = cliche.reduce((a, w) => a + count(text, w), 0);
  const dimVague = clamp((hits / n) * 100 * 90);

  let mean = 0, sd = 0, cv = 0;
  if (lens.length) {
    [mean, sd] = std(lens);
    cv = mean ? sd / mean : 0;
  }
  const bank = clamp(((0.42 - cv) / 0.42) * 100);
  const starts = {};
  for (const s of sents) {
    const k = s.slice(0, 4);
    starts[k] = (starts[k] || 0) + 1;
  }
  const startRep = Math.max(0, ...Object.values(starts)) / Math.max(1, sents.length);
  const connDensity = ((c.connectors || []).reduce((a, w) => a + count(text, w), 0) / n) * 100;
  const triads = (text.match(new RegExp(c.triadPattern, 'g')) || []).length;
  const dimSyntax = clamp(bank * 0.45 + startRep * 250 * 0.25 + connDensity * 110 * 0.2 + triads * 3);

  const concrete = new RegExp(c.concretePattern);
  const abstract = sents.filter((s) => !concrete.test(s));
  const dimConcrete = clamp((abstract.length / Math.max(1, sents.length)) * 100);

  const ng = c.repeatNgram || 6;
  const grams = {};
  for (let i = 0; i <= text.length - ng; i++) {
    const g = text.slice(i, i + ng);
    if (!/[ ，。：、｜　]/.test(g)) grams[g] = (grams[g] || 0) + 1;
  }
  let rep = 0;
  for (const v of Object.values(grams)) if (v >= (c.repeatMinCount || 4)) rep += v - 2;
  const dimRepeat = clamp(rep * (c.repeatWeight || 4), 0, c.repeatCap || 60);

  const humanHits = (c.colloquial || []).reduce((a, w) => a + count(text, w), 0);
  const dimHuman = clamp(100 - (humanHits / Math.max(1, sents.length)) * (c.humanPenaltyScale || 300));

  const dims = {
    结构模板: dimStruct,
    空泛词: dimVague,
    句法机械: dimSyntax,
    信息具体度: dimConcrete,
    重复堆砌: dimRepeat,
    人味缺失: dimHuman,
  };
  const w = prof.weights;
  const score = (
    dims['结构模板'] * w.struct + dims['空泛词'] * w.vague + dims['句法机械'] * w.syntax
    + dims['信息具体度'] * w.concrete + dims['重复堆砌'] * w.repeat + dims['人味缺失'] * w.human
  ) / 100;

  const FIX = {
    标签式开头: '改成完整句，或换开头',
    '破折号/箭头': '拆句或改顿号',
    没有具体信息: '补对象/数字/时间/动作',
    一句太长: '拆两句，长短交错',
    三连以上并列: '留 1–2 项最关键的',
  };
  const flags = [];
  const add = (kind, sentence) => {
    if (!flags.some((f) => f.kind === kind && f.sentence === sentence)) {
      const fix = kind.startsWith('空泛词')
        ? '换成具体动作或事实'
        : (FIX[kind] || '按具体信息重写');
      flags.push({ kind, sentence, fix });
    }
  };
  for (const b of bullets) {
    const t = b.replace(/^[•·-]\s*/, '').trim();
    if (isLabel(t, cfg)) add('标签式开头', t);
    if (t.includes('—') || t.includes('→')) add('破折号/箭头', t);
    const hit = cliche.filter((x) => t.includes(x)).slice(0, 3);
    if (hit.length) add(`空泛词 ${hit.join('/')}`, t);
    for (const s of t.split(SENT_RE)) {
      const x = s.trim();
      if (x.length < 6) continue;
      if (x.length > (c.maxSentenceLength || 50)) add('一句太长', x);
      if (!concrete.test(x)) add('没有具体信息', x);
      if (new RegExp(c.triadPattern).test(x)) add('三连以上并列', x);
    }
  }

  const band = cfg.bands.find((b) => score < b.max) || cfg.bands[cfg.bands.length - 1];
  return {
    score: Math.round(score * 10) / 10,
    band: band.label,
    bandAction: band.action || '',
    genre: prof.name,
    note: prof.note || '',
    dims: Object.entries(dims).map(([k, v]) => ({ name: k, value: Math.round(v) })),
    stats: {
      段落: paras.length,
      句子: sents.length,
      平均句长: Math.round(mean * 10) / 10,
      变异系数: Math.round(cv * 100) / 100,
      标签式: labels.length,
      模板词: hits,
      空句比例: Math.round((abstract.length / Math.max(1, sents.length)) * 100) / 100,
    },
    flags,
  };
}

/* ---------------- 渲染 ---------------- */
function renderAudit(args, value) {
  const lines = [
    `AI 味分数：${value.score}/100（${value.band}）　文体：${value.genre}`,
    `维度：${value.dims.map((d) => `${d.name} ${d.value}`).join(' / ')}`,
    `统计：${Object.entries(value.stats).map(([k, v]) => `${k} ${v}`).join(' / ')}`,
  ];
  if (value.note) lines.push(`提示：${value.note}`);
  lines.push('');
  if (value.flags.length === 0) {
    lines.push('没有命中打标项，读一遍念着顺就可以交付。');
  } else {
    const limit = args.detail === 'full' ? 40 : 10;
    lines.push(`要改的句子（${Math.min(limit, value.flags.length)}/${value.flags.length} 条）：`);
    value.flags.slice(0, limit).forEach((f, i) => {
      lines.push(`${i + 1}. [${f.kind}] ${f.sentence}`);
      lines.push(`   改法：${f.fix}`);
    });
    if (value.flags.length > limit) lines.push(`（还有 ${value.flags.length - limit} 条，用 detail:"full" 看全部）`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/* ---------------- 参数与输出 schema ---------------- */
const AUDIT_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: '要审的文案正文，可含换行和多段。' },
    genre: {
      type: 'string',
      enum: ['resume', 'report', 'article', 'marketing', 'bid', 'email'],
      description: '文体：resume 简历/述职；report 方案/汇报；article 公众号/知乎；marketing 营销；bid 标书；email 邮件。省略则用默认文体。',
    },
    detail: {
      type: 'string',
      enum: ['summary', 'full'],
      description: 'summary 给前 10 条打标句；full 给前 40 条。默认 summary。',
    },
  },
  required: ['text'],
};

const AUDIT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    score: { type: 'number' },
    band: { type: 'string' },
    bandAction: { type: 'string' },
    genre: { type: 'string' },
    note: { type: 'string' },
    dims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' }, value: { type: 'number' } },
        required: ['name', 'value'],
      },
    },
    stats: {
      type: 'object',
      additionalProperties: false,
      properties: {
        段落: { type: 'number' },
        句子: { type: 'number' },
        平均句长: { type: 'number' },
        变异系数: { type: 'number' },
        标签式: { type: 'number' },
        模板词: { type: 'number' },
        空句比例: { type: 'number' },
      },
      required: ['段落', '句子', '平均句长', '变异系数', '标签式', '模板词', '空句比例'],
    },
    flags: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          sentence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['kind', 'sentence', 'fix'],
      },
    },
  },
  required: ['score', 'band', 'bandAction', 'genre', 'note', 'dims', 'stats', 'flags'],
};

const CONFIG_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['get', 'genres', 'set', 'reset'],
      description: 'get 读配置；genres 列文体；set 写用户配置（config 传 JSON 字符串）；reset 恢复默认。',
    },
    config: { type: 'string', description: 'action=set 时的完整配置 JSON 字符串。' },
  },
  required: ['action'],
};

const CONFIG_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    path: { type: 'string' },
    message: { type: 'string' },
    config: { type: 'string' },
    genres: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['id', 'name', 'note'],
      },
    },
  },
  required: ['ok', 'path', 'message'],
};

/* ---------------- 注册 ---------------- */
export function apply(ctx) {
  ctx.tools.register({
    name: 'deai_audit',
    description:
      'Score Chinese copy for "AI flavor" and list sentences that need rewriting. '
      + 'Use when the user asks to check or remove AI flavor (去 AI 味, 太像 AI, 润色), or before delivering '
      + 'outward-facing copy (简历、述职、方案/汇报、公众号、营销文案、标书、邮件). '
      + 'Returns a 0-100 score (lower is more natural), six dimension scores, and flagged sentences with fix hints. '
      + 'After scoring, rewrite only the flagged sentences yourself and keep facts and jargon (PMP/GIS/驻场/联调) intact.',
    parameters: AUDIT_PARAMS,
    output: { schema: AUDIT_OUTPUT, render: renderAudit },
    async execute(args) {
      const cfg = loadConfig();
      const genre = args.genre || cfg.defaultGenre || 'resume';
      return analyze(splitParas(args.text), genre, cfg);
    },
  });

  ctx.tools.register({
    name: 'deai_audit_config',
    description:
      'Read or change the deai_audit configuration: list genres, dump/merge the config JSON, or reset to defaults. '
      + 'Config covers word lists, regexes, thresholds, score bands and per-genre dimension weights.',
    parameters: CONFIG_PARAMS,
    output: { schema: CONFIG_OUTPUT, render: (_a, v) => [{ type: 'text', text: v.message }] },
    async execute(args) {
      const path = configPath();
      if (args.action === 'genres') {
        const cfg = loadConfig();
        return {
          ok: true,
          path,
          message: cfg.genres.map((g) => `${g.id}  ${g.name}`).join('\n'),
          genres: cfg.genres.map((g) => ({ id: g.id, name: g.name, note: g.note || '' })),
        };
      }
      if (args.action === 'get') {
        const cfg = loadConfig();
        const dump = JSON.stringify(cfg, null, 2);
        return {
          ok: true,
          path,
          message: `当前配置文件：${path}\n${dump.slice(0, 4000)}`,
          config: dump,
        };
      }
      if (args.action === 'set') {
        if (!args.config) throw new Error('action=set 需要 config（完整 JSON 字符串）');
        let next;
        try {
          next = JSON.parse(args.config);
        } catch (e) {
          throw new Error('config 不是合法 JSON：' + e.message);
        }
        const saved = saveUserConfig(next);
        return { ok: true, path: saved, message: `已写入用户配置：${saved}` };
      }
      if (args.action === 'reset') {
        if (existsSync(USER_CONFIG)) unlinkSync(USER_CONFIG);
        return { ok: true, path: configPath(), message: '已删除用户配置，恢复为包内默认配置' };
      }
      return { ok: false, path, message: `未知 action：${args.action}` };
    },
  });
}

export default { name, inject, apply };
