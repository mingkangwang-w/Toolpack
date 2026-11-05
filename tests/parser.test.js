import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestions } from '../web/js/parser.js';

test('解析标准单选题，并提取答案与解析', () => {
  const text = `
一、单项选择题

1. 下列关于细胞膜的叙述，正确的是（  ）
A. 细胞膜是全透性的结构
B. 细胞膜的基本支架是磷脂双分子层
C. 细胞膜上的蛋白质都不能运动
D. 细胞膜只由脂质和蛋白质组成
答案：B
解析：磷脂双分子层构成细胞膜的基本支架，
蛋白质分子可以运动，细胞膜具有选择透过性。

2. 下列属于可再生能源的是（  ）
A. 煤炭  B. 石油  C. 风能  D. 天然气
答案：C
  `;

  const questions = parseQuestions(text);
  assert.equal(questions.length, 2);

  assert.equal(questions[0].type, 'single');
  assert.match(questions[0].stem, /下列关于细胞膜/);
  assert.equal(questions[0].options.length, 4);
  assert.equal(questions[0].options[2].key, 'C');
  assert.equal(questions[0].answer, 'B');
  assert.match(questions[0].explanation, /磷脂双分子层/);

  assert.equal(questions[1].type, 'single');
  assert.deepEqual(questions[1].options.map((option) => option.key), ['A', 'B', 'C', 'D']);
  assert.equal(questions[1].options[2].text, '风能');
  assert.equal(questions[1].answer, 'C');
});

test('题目正文里的「填写答案：」不会被当作答案行', () => {
  const text = `
1. 请在横线上填写答案：水的化学式是______。
答案：H₂O
  `;
  const [question] = parseQuestions(text);
  assert.equal(question.type, 'fill');
  assert.match(question.stem, /填写答案/);
  assert.equal(question.answer, 'H₂O');
  assert.equal(question.options.length, 0);
});

test('识别简答题并保留文本参考答案', () => {
  const text = `
1. （简答题）简述光合作用的过程。
参考答案：光反应阶段和暗反应阶段。
  `;
  const [question] = parseQuestions(text);
  assert.equal(question.type, 'short');
  assert.equal(question.options.length, 0);
  assert.match(question.stem, /简述光合作用/);
  assert.doesNotMatch(question.stem, /简答题/);
  assert.match(question.answer, /光反应阶段/);
});

test('解析多选题并识别多个答案字母', () => {
  const text = `
1. （多选题）下列属于哺乳动物的有（  ）
A. 鲸
B. 蝙蝠
C. 企鹅
D. 海豚
【答案】A、B、D
【解析】鲸、蝙蝠和海豚都是哺乳动物。
  `;
  const [question] = parseQuestions(text);
  assert.equal(question.type, 'multiple');
  assert.equal(question.answer, 'ABD');
  assert.equal(question.options.length, 4);
});

test('识别无选项的判断题并补齐正确/错误选项', () => {
  const text = `
1. 判断：植物细胞都含有叶绿体。（  ）
答案：错误
  `;
  const [question] = parseQuestions(text);
  assert.equal(question.type, 'judge');
  assert.deepEqual(question.options, [
    { key: 'A', text: '正确' },
    { key: 'B', text: '错误' },
  ]);
  assert.equal(question.answer, 'B');
});

test('判断题文字答案映射到选项字母', () => {
  const text = `
1. （判断题）声音可以在真空中传播。
A. 对
B. 错
答案：错
  `;
  const [question] = parseQuestions(text);
  assert.equal(question.type, 'judge');
  assert.equal(question.answer, 'B');
});

test('答案和解析写在同一行', () => {
  const text = `
1. 2 的平方是多少（  ）
A. 2
B. 4
C. 8
D. 16
答案：B 解析：2 的平方等于 4。
  `;
  const [question] = parseQuestions(text);
  assert.equal(question.answer, 'B');
  assert.match(question.explanation, /等于 4/);
});

test('兼容没有标点的「A 选项」行', () => {
  const text = `
1. 首都是北京的国家是
A 中国
B 日本
C 韩国
D 泰国
答案：A
  `;
  const [question] = parseQuestions(text);
  assert.equal(question.type, 'single');
  assert.deepEqual(question.options.map((option) => option.text), ['中国', '日本', '韩国', '泰国']);
  assert.equal(question.answer, 'A');
});

test('题干中的 A、B、C 列举不会被误当成选项', () => {
  const text = '1. 如图，A、B、C 三点共线，求线段 AB 的长度。';
  const [question] = parseQuestions(text);
  assert.equal(question.options.length, 0);
  assert.equal(question.type, 'fill');
  assert.match(question.stem, /三点共线/);
});

test('没有编号的单题也能解析', () => {
  const text = `
下列哪个是质数？（  ）
A. 4
B. 6
C. 7
D. 9
答案：C
  `;
  const [question] = parseQuestions(text);
  assert.equal(question.type, 'single');
  assert.equal(question.answer, 'C');
});

test('题号支持「第1题」与全角符号', () => {
  const text = `
第1题　中国的首都是（  ）
A．北京
B．上海
答案：A

第2题　一年有几个月？
答案：12
  `;
  const questions = parseQuestions(text);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].stem, '中国的首都是（ ）');
  assert.equal(questions[1].type, 'fill');
});

test('多个图片的文本可以连续导入，分节标题会自动忽略', () => {
  const text = `
八年级生物练习
一、选择题
1. 光合作用的场所是（ ）
A. 线粒体
B. 叶绿体
答案：B

二、填空题
2. 呼吸作用的主要场所是______。
答案：线粒体
  `;
  const questions = parseQuestions(text);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].answer, 'B');
  assert.equal(questions[1].type, 'fill');
});

test('解析手机截图中的时间栏、教师批阅和正确答案行', () => {
  const text = `
7:34 16° 54
作业详情
7 8 9 10 11 12 13
1.(单选题）
电动泵英文缩写是：
A. EDP
B. EMDP
C. ADP
D. RAT
教师批阅
正确答案Ｃ，我的答案：C
  `;
  const questions = parseQuestions(text);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].type, 'single');
  assert.doesNotMatch(questions[0].stem, /单选题|作业详情|教师批阅|7:34/);
  assert.equal(questions[0].answer, 'C');
  assert.equal(questions[0].options.length, 4);
  assert.equal(questions[0].options[3].text, 'RAT');
  assert.doesNotMatch(questions[0].options[3].text, /教师批阅/);
});

test('正确答案行的「我的答案」不会覆盖正确答案', () => {
  const text = `
1. 单选题
题目文字
A. 甲
B. 乙
正确答案B，我的答案：A
  `;
  const [question] = parseQuestions(text);
  assert.equal(question.answer, 'B');
});

test('空白输入返回空数组', () => {
  assert.deepEqual(parseQuestions(' \n\n '), []);
});
