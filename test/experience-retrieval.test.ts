import { describe, expect, it, vi } from "vitest";
import { assertPublicRetrievalText } from "../src/experience/retrieval-text.js";
import type { LibraryEntry } from "../src/benchmark/swe-holdout.js";
import type { SweTask } from "../src/benchmark/swe-mini.js";
import { sha256Text } from "../src/evaluation/schema.js";
import { parseApplicability, parseSearchCard, rankGuidance, selectGuidance, sourceText,
  type ApplicabilityDecision, type SearchCard } from "../src/experience/retrieval.js";

const task: SweTask = { instance_id: "django__django-123", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "用户名校验失败，长度限制失效。 Validate username length before authentication." };
function entry(id = "a", content = "检查用户名长度限制。 Validate username length before authentication."): LibraryEntry {
  return { sourceTaskId: "django__django-1", sourceExperienceId: "e1", sourceRunId: "r1", title: "输入校验", applicability: ["用户名校验失败"], contraindications: ["仅网络连接失败"],
    candidate: { id, kind: "strategy", content, contentSha256: sha256Text(content), rendererVersion: 1 } };
}
function card(item: LibraryEntry): SearchCard {
  return { candidateId: item.candidate.id, contentSha256: item.candidate.contentSha256, mechanism: "用户名长度限制", triggers: ["用户名校验失败"], exclusions: ["网络连接失败"], action: "检查长度校验", stage: "initial", keywords: ["用户名", "长度", "username", "length"], sourceQuotes: ["用户名校验失败"] };
}
function decision(item: LibraryEntry, overrides: Partial<ApplicabilityDecision> = {}): ApplicabilityDecision {
  return { candidateId: item.candidate.id, verdict: "direct", reason: "问题与经验均包含用户名长度校验", taskQuotes: ["用户名校验失败"], experienceQuotes: ["用户名校验失败"], contraindication: "absent", stage: "initial", redundantWith: null, ...overrides };
}
const ranked = (items: LibraryEntry[]) => items.map((item, index) => ({ id: item.candidate.id, score: 10 - index, matchedTerms: 2 }));
const output = (decisions: unknown[]) => JSON.stringify({ decisions });

describe("SWE V2 检索卡", () => {
  it("公开索引关键词允许普通代码赋值，但仍拒绝凭据", () => {
    expect(parseSearchCard({ ...card(entry()), keywords: ["resolved=false"] }, entry()).keywords).toEqual(["resolved=false"]);
    expect(() => parseSearchCard({ ...card(entry()), keywords: ["api_key=sk-test-secret-123456789"] }, entry())).toThrow();
  });
  it("规范原文包含标题、条件、禁忌与未改写正文", () => {
    expect(sourceText(entry("a", "  原文\n保持缩进  "))).toBe("输入校验\n用户名校验失败\n仅网络连接失败\n  原文\n保持缩进  ");
    expect(parseSearchCard(card(entry()), entry()).candidateId).toBe("a");
  });
  it.each([
    { candidateId: "unknown" }, { contentSha256: "a".repeat(64) }, { keywords: [] }, { keywords: ["123---"] },
    { sourceQuotes: [] }, { sourceQuotes: ["捏造经验引句"] }, { mechanism: "x".repeat(2001) }, { action: "\u001b[31m" },
    { action: "api_key=sk-test-secret-123456789" }, { extra: "unexpected" },
  ])("拒绝损坏或不可信检索卡 %j", (change) => {
    expect(() => parseSearchCard({ ...card(entry()), ...change }, entry())).toThrow();
  });
  it("来源候选哈希或元数据损坏时所有入口拒绝", () => {
    const broken = entry(); broken.candidate.content = "改过的正文";
    expect(() => sourceText(broken)).toThrow();
    expect(() => parseSearchCard(card(broken), broken)).toThrow();
    expect(() => rankGuidance(task, [broken], [])).toThrow();
    expect(() => selectGuidance(task, [broken], [], [])).toThrow();
    expect(() => sourceText({ ...entry(), title: "\u202e恶意标题" })).toThrow();
  });
});

describe("SWE V2 BM25", () => {
  it("普通任务无需 SWE 仓库与实例字段", () => {
    expect(rankGuidance({ problem_statement: "用户名长度限制" } as SweTask, [entry()], [card(entry())])).toMatchObject([{ id: "a" }]);
  });
  it("纯中文问题可匹配连续中文关键词，并跳过无卡条目", () => {
    const items = [entry(), entry("b")];
    expect(rankGuidance({ ...task, problem_statement: "用户名长度限制失效" }, items, [card(items[0]!)])).toMatchObject([{ id: "a" }]);
  });
  it("无词命中返回零，不使用隐藏答案或结果", () => {
    const input = { ...task, problem_statement: "quasar nebula", patch: "username length", result: true };
    expect(rankGuidance(input, [entry()], [card(entry())])).toEqual([]);
  });
  it("英文信息词可检索，默认最多8条且平分按ID固定", () => {
    const items = Array.from({ length: 10 }, (_, index) => entry(`c${index}`));
    const result = rankGuidance({ ...task, problem_statement: "username length" }, items, items.map(card));
    expect(result.map((value) => value.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
    expect(rankGuidance(task, items, items.map(card), 2)).toHaveLength(2);
    expect(() => rankGuidance(task, items, items.map(card), 9)).toThrow();
  });
  it("直接传入未解析卡也不能绕过绑定，重复和未知卡拒绝", () => {
    expect(() => rankGuidance(task, [entry()], [{ ...card(entry()), contentSha256: "0".repeat(64) }])).toThrow();
    expect(() => rankGuidance(task, [entry()], [card(entry()), card(entry())])).toThrow();
    expect(() => rankGuidance(task, [entry()], [card(entry("b"))])).toThrow();
    expect(() => rankGuidance(task, [entry(), entry()], [])).toThrow();
  });
});

describe("SWE V2 适用性证据", () => {
  it("公开任务的普通代码赋值可原样引用，经验文本校验仍保持严格", () => {
    const problem_statement = "name = klass.__name__\nmax_eps=1.0\n用户名校验失败";
    const input = { ...task, problem_statement };
    expect(() => assertPublicRetrievalText(problem_statement)).not.toThrow();
    const parsed = parseApplicability(output([decision(entry(), { taskQuotes: ["name = klass.__name__", "max_eps=1.0"] })]), input, [entry()]);
    expect(parsed[0]?.taskQuotes).toEqual(["name = klass.__name__", "max_eps=1.0"]);
    expect(selectGuidance(input, [entry()], ranked([entry()]), parsed).selectedIds).toEqual(["a"]);
    expect(() => sourceText(entry("bad", "max_eps=1.0"))).toThrow();
  });
  it.each(["Bearer test-credential-123456789", "sk-test-secret-123456789", "api_key=example-credential-123456789", "\u001b[0m", "\u202eabc"])("公开正文与所有任务入口仍拒绝凭据和控制符 %j", (unsafe) => {
    const input = { ...task, problem_statement: `${task.problem_statement}\n${unsafe}` };
    expect(() => assertPublicRetrievalText(unsafe)).toThrow();
    expect(() => rankGuidance(input, [entry()], [card(entry())])).toThrow();
    expect(() => parseApplicability(output([decision(entry())]), input, [entry()])).toThrow();
    expect(() => selectGuidance(input, [entry()], ranked([entry()]), [decision(entry())])).toThrow();
  });
  it("公开正文仍拒绝当前环境已注册的密钥值", () => {
    vi.stubEnv("RETRIEVAL_TEST_API_KEY", "test-registered-credential-123456789");
    try {
      expect(() => assertPublicRetrievalText("prefix test-registered-credential-123456789 suffix")).toThrow();
    } finally { vi.unstubAllEnvs(); }
  });
  it("验证每个候选的确切任务与经验引句，并按输入候选顺序输出", () => {
    const a = entry(), b = entry("b");
    expect(parseApplicability(output([decision(b), decision(a)]), task, [a, b]).map((value) => value.candidateId)).toEqual(["a", "b"]);
  });
  it.each([
    [], [decision(entry()), decision(entry())], [decision(entry("z"))],
    [decision(entry(), { taskQuotes: ["未经观察的代码"] })], [decision(entry(), { taskQuotes: ["django/django"] })],
    [decision(entry(), { experienceQuotes: ["捏造经验"] })], [decision(entry(), { taskQuotes: [] })],
    [decision(entry(), { reason: "token=sk-test-secret-123456789" })], [decision(entry(), { reason: "\u001b[0m" })],
    [{ ...decision(entry()), extra: true }],
  ])("拒绝遗漏重复未知ID或伪造证据 %j", (...values) => {
    expect(() => parseApplicability(output(values), task, [entry()])).toThrow();
  });
  it("不接受代码围栏、额外顶层字段和后向/自身冗余指针", () => {
    expect(() => parseApplicability("```json\n" + output([decision(entry())]) + "\n```", task, [entry()])).toThrow();
    expect(() => parseApplicability(JSON.stringify({ decisions: [decision(entry())], other: true }), task, [entry()])).toThrow();
    expect(() => parseApplicability(output([decision(entry(), { redundantWith: "a" })]), task, [entry()])).toThrow();
    expect(() => parseApplicability(output([decision(entry(), { redundantWith: "b" }), decision(entry("b"))]), task, [entry(), entry("b")])).toThrow();
  });
});

describe("SWE V2 注入", () => {
  it.each([
    { verdict: "general" }, { verdict: "unknown" }, { verdict: "inapplicable" },
    { contraindication: "present" }, { contraindication: "unknown" }, { stage: "after_inspection" }, { stage: "after_error" },
  ] as Partial<ApplicabilityDecision>[])("不明确支持初始注入时保留理由并零注入 %j", (change) => {
    const items = [entry()];
    const parsed = parseApplicability(output([decision(items[0]!, change)]), task, items);
    const result = selectGuidance(task, items, ranked(items), parsed);
    expect(result.candidate).toBeNull(); expect(result.selectedIds).toEqual([]);
    expect(result.reasons).toMatchObject([{ candidateId: "a", selected: false }]);
    expect(result.reasons[0]?.reason).toBeTruthy();
  });
  it("允许零项/缺失决策降级，正文与来源hash不变且最多两条", () => {
    const items = [entry("a", "  原文A\n保留空格  "), entry("b", "原文B"), entry("c", "原文C")];
    const before = JSON.stringify(items);
    const result = selectGuidance(task, items, ranked(items), items.map((item) => decision(item)));
    expect(result.selectedIds).toEqual(["a", "b"]);
    expect(result.candidate?.content).toBe("### Source guidance a\n  原文A\n保留空格  \n\n### Source guidance b\n原文B");
    expect(result.candidate?.contentSha256).toBe(sha256Text(result.candidate!.content));
    expect(result.candidate?.id).not.toBe("a"); expect(result.reasons).toHaveLength(3);
    expect(JSON.stringify(items)).toBe(before);
    expect(selectGuidance(task, items, ranked(items), []).candidate).toBeNull();
    expect(selectGuidance(task, items, [], []).candidate).toBeNull();
  });
  it("内容hash重复和已选冗余去重，但未选目标不阻止后续选择", () => {
    const items = [entry("a", "A"), entry("b", "A"), entry("c", "C"), entry("d", "D")];
    const result = selectGuidance(task, items, ranked(items), [decision(items[0]!), decision(items[1]!), decision(items[2]!, { redundantWith: "a" }), decision(items[3]!)]);
    expect(result.selectedIds).toEqual(["a", "d"]);
    expect(selectGuidance(task, items, ranked(items), [decision(items[0]!, { verdict: "general" }), decision(items[2]!, { redundantWith: "a" })]).selectedIds).toEqual(["c"]);
  });
  it("沿冗余引用链识别已选祖先及相同正文祖先", () => {
    const items = [entry("a", "A"), entry("b", "A"), entry("c", "C"), entry("d", "D"), entry("e", "E")];
    const decisions = [decision(items[0]!), decision(items[1]!), decision(items[2]!, { redundantWith: "b" }),
      decision(items[3]!, { redundantWith: "c" }), decision(items[4]!)];
    expect(selectGuidance(task, items, ranked(items), decisions).selectedIds).toEqual(["a", "e"]);
    const distinct = [entry("a", "A"), entry("b", "B"), entry("c", "C"), entry("d", "D")];
    const chain = distinct.map((item, index) => decision(item, { redundantWith: index ? distinct[index - 1]!.candidate.id : null }));
    expect(selectGuidance(task, distinct, ranked(distinct), chain).selectedIds).toEqual(["a"]);
  });
  it("总正文含来源标题与分隔符不超过9000字符，不截断原文", () => {
    const items = [entry("a", "A".repeat(8900)), entry("b", "B".repeat(100)), entry("c", "C".repeat(10))];
    const result = selectGuidance(task, items, ranked(items), items.map((item) => decision(item)));
    expect(result.selectedIds).toEqual(["a", "c"]);
    expect(result.candidate!.content.length).toBeLessThanOrEqual(9000);
    expect(result.candidate!.content).toContain("A".repeat(8900));
    const long = entry("long", "x".repeat(9000));
    expect(selectGuidance(task, [long], ranked([long]), [decision(long)]).candidate).toBeNull();
  });
  it("选择入口重验引句/重复决策/未知ranking与非有限分数", () => {
    const items = [entry()];
    expect(() => selectGuidance(task, items, ranked(items), [decision(items[0]!, { taskQuotes: ["捏造"] })])).toThrow();
    expect(() => selectGuidance(task, items, ranked(items), [decision(items[0]!), decision(items[0]!)])).toThrow();
    expect(() => selectGuidance(task, items, ranked([entry("z")]), [])).toThrow();
    expect(() => selectGuidance(task, items, [{ id: "a", score: NaN, matchedTerms: 2 }], [])).toThrow();
  });
});
