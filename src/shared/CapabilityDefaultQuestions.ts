import type { CapabilityQuestion } from "./types";
export type { CapabilityQuestion };

export const CAPABILITY_SUITE_VERSION = "CapabilitySuite-1.1";

const jsonInstruction = '只返回一个 JSON 对象，不要输出 Markdown、解释或分析。普通题格式：{"answer":"最终答案"}。';
const codeInstruction = '只返回一个 JSON 对象，格式为 {"code":"function solution(...) { ... }"}，不要输出 Markdown 或解释。';

export const capabilityQuestions: CapabilityQuestion[] = [
  {
    id: "code.brackets",
    dimension: "code",
    title: "括号匹配函数",
    prompt: `${codeInstruction}请用 JavaScript/TypeScript 实现 function solution(text)，判断字符串中的 (), [], {} 是否正确嵌套，忽略其它字符。输入 a(b[c]{d}) 返回 true，输入 ([)] 返回 false。`,
    responseKey: "code",
    maxScore: 5,
    rule: { kind: "code", checks: ["function\\s+solution", "push|stack", "pop", "return", "\\(\\[\\]\\{\\}"] },
  },
  {
    id: "code.topK",
    dimension: "code",
    title: "高频词排序函数",
    prompt: `${codeInstruction}请实现 function solution(words, k)，返回出现频率最高的 k 个单词；频率相同时按字典序升序。要求不修改输入数组。`,
    responseKey: "code",
    maxScore: 5,
    rule: { kind: "code", checks: ["function\\s+solution", "Map|reduce|Object", "sort", "frequency|count|次数", "return"] },
  },
  {
    id: "translation.enZh.config",
    dimension: "translation",
    title: "产品说明翻译",
    prompt: `${jsonInstruction}将下列英文翻译成中文，只把译文放入 answer：Please save the configuration before running the test and export the report after it finishes.`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "keywords", groups: [["保存", "存储", "备份"], ["测试前", "运行测试之前", "开始测试前"], ["导出.*报告", "报告.*导出"], ["完成后", "结束后", "测试结束"]] },
  },
  {
    id: "translation.zhEn.reproduce",
    dimension: "translation",
    title: "故障排查翻译",
    prompt: `${jsonInstruction}将下列中文翻译成英文，只把译文放入 answer：如果结果不一致，请记录错误信息和复现步骤。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "keywords", groups: [["if", "when", "in case"], ["inconsistent", "different", "do not match", "discrepancy"], ["record", "log", "write down"], ["error message", "error"], ["reproduction steps", "steps to reproduce", "reproduce"]] },
  },
  {
    id: "classical.learning",
    dimension: "classicalChinese",
    title: "学而时习之",
    prompt: `${jsonInstruction}将“学而时习之，不亦说乎？”翻译成现代汉语，至少 15 个汉字，只把译文放入 answer。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "keywords", groups: [["学习", "学"], ["经常", "按时", "时常"], ["复习", "温习", "练习"], ["高兴", "愉快", "快乐", "喜悦"]], minimumLength: 15 },
  },
  {
    id: "classical.firstWorry",
    dimension: "classicalChinese",
    title: "先忧后乐",
    prompt: `${jsonInstruction}将“先天下之忧而忧，后天下之乐而乐。”翻译成现代汉语，至少 15 个汉字，只把译文放入 answer。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "keywords", groups: [["天下", "百姓", "公众"], ["先", "首先"], ["忧", "忧虑", "担忧"], ["后", "然后"], ["乐", "快乐", "享乐"]], minimumLength: 15 },
  },
  {
    id: "math.linear",
    dimension: "math",
    title: "一元一次方程",
    prompt: `${jsonInstruction}解方程 4(2x−3)=3x+12，只把 x 的最终数值放入 answer，可写成分数或小数。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "number", answers: ["24/5", "4.8"], tolerance: 0.02 },
  },
  {
    id: "math.discount",
    dimension: "math",
    title: "连续优惠计算",
    prompt: `${jsonInstruction}标价 800 元，先打八折，再减 100 元，实付多少元？只把最终数字放入 answer。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "number", answers: ["540"], tolerance: 0.01 },
  },
  {
    id: "logic.sequence",
    dimension: "logic",
    title: "数列规律",
    prompt: `${jsonInstruction}数列为 3, 8, 15, 24, 35, ?，请给出下一个数字并简要说明规律，只把最终数字放入 answer。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "number", answers: ["48"], tolerance: 0.01 },
  },
  {
    id: "logic.contrapositive",
    dimension: "logic",
    title: "逆否命题",
    prompt: `${jsonInstruction}若服务器过载，则队列长度增加。已知队列未增加，可确定什么？只把选项和结论放入 answer：A 未过载；B 无请求；C 响应更快；D 无法确定。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "exact", aliases: ["A", "未过载", "服务器没有过载"] },
  },
  {
    id: "knowledge.chushibiao",
    dimension: "chineseKnowledge",
    title: "《出师表》对象",
    prompt: `${jsonInstruction}《出师表》主要写给谁？只把人物姓名放入 answer。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "exact", aliases: ["刘禅", "劉禪", "刘阿斗"] },
  },
  {
    id: "knowledge.shiji",
    dimension: "chineseKnowledge",
    title: "《史记》作者",
    prompt: `${jsonInstruction}《史记》的作者是谁？只把人物姓名放入 answer。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "exact", aliases: ["司马迁", "司馬遷"] },
  },
  {
    id: "creative.story",
    dimension: "creativeWriting",
    title: "雨夜与未寄出的信",
    prompt: `${jsonInstruction}请围绕“雨夜、旧车站、未寄出的信”写一段 120 至 180 字的中文微型故事，必须包含人物、情绪变化和一个出人意料的转折，只把故事放入 answer。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "keywords", groups: [["雨夜", "下雨", "雨幕"], ["车站", "站台"], ["信", "未寄", "信封"], ["人物", "他", "她", "老人", "孩子"], ["转折", "原来", "却", "没想到"]], minimumLength: 80 },
  },
  {
    id: "creative.productCopy",
    dimension: "creativeWriting",
    title: "低碳产品创意文案",
    prompt: `${jsonInstruction}为一款可折叠、可重复使用的城市通勤水杯写一段不少于 70 字的中文广告文案，突出低碳、便携和一个具体使用场景，只把文案放入 answer。`,
    responseKey: "answer",
    maxScore: 5,
    rule: { kind: "keywords", groups: [["低碳", "环保", "减塑"], ["折叠", "便携", "轻便", "随身"], ["通勤", "地铁", "办公室", "出行"], ["水杯", "杯子", "饮水"], ["行动", "使用", "带上", "购买"]], minimumLength: 50 },
  },
];

export function getCapabilityQuestions(): CapabilityQuestion[] {
  return capabilityQuestions.map((question) => ({ ...question, rule: { ...question.rule } }));
}