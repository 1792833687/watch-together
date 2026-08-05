#!/usr/bin/env node
/**
 * Watch Together - 代码结构分析脚本
 * 用法: node scripts/analyze-structure.js
 */
const fs = require('fs');
const path = require('path');

const APP_FILE = path.join(__dirname, '..', 'app.js');

if (!fs.existsSync(APP_FILE)) {
  console.error('❌ 找不到 app.js 文件');
  process.exit(1);
}

const source = fs.readFileSync(APP_FILE, 'utf-8');
const lines = source.split('\n');

// ============================================
// 1. 模块分布分析
// ============================================
console.log('📊 模块分布分析\n');
const modulePattern = /^\/\/\s=+\s*$/;
const moduleNamePattern = /^\/\/\s(.+?)\s*$/;

let currentModule = 'TOP LEVEL';
const modules = {};
let moduleStart = 1;

lines.forEach((line, i) => {
  if (modulePattern.test(line) && i + 1 < lines.length) {
    const nameMatch = lines[i + 1].match(moduleNamePattern);
    if (nameMatch && !nameMatch[1].startsWith('=')) {
      if (!modules[currentModule]) modules[currentModule] = { start: moduleStart, end: i, lines: 0 };
      modules[currentModule].end = i;
      modules[currentModule].lines = i - modules[currentModule].start;
      currentModule = nameMatch[1].trim();
      moduleStart = i;
    }
  }
});
modules[currentModule] = { start: moduleStart, end: lines.length, lines: lines.length - moduleStart };

console.log('Module'.padEnd(35) + 'Lines'.padEnd(8) + 'Range');
console.log('-'.repeat(60));
let totalModuleLines = 0;
for (const [name, info] of Object.entries(modules)) {
  if (info.lines > 0) {
    console.log(
      name.padEnd(35) +
      String(info.lines).padEnd(8) +
      `${info.start}-${info.end}`
    );
    totalModuleLines += info.lines;
  }
}
console.log('-'.repeat(60));
console.log(`Total: ${Object.keys(modules).length} modules, ${totalModuleLines} lines`);

// ============================================
// 2. 函数统计
// ============================================
console.log('\n📊 函数统计\n');
const funcPattern = /^(?:async\s+)?function\s+(\w+)/;
const arrowPattern = /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/;
const functions = [];

lines.forEach((line, i) => {
  const funcMatch = line.match(funcPattern);
  const arrowMatch = line.match(arrowPattern);
  if (funcMatch) {
    functions.push({ name: funcMatch[1], line: i + 1, type: 'function' });
  } else if (arrowMatch && !arrowMatch[1].match(/^(CONFIG|State|dom|\$|\$\$)/)) {
    functions.push({ name: arrowMatch[1], line: i + 1, type: 'arrow' });
  }
});

console.log(`总函数数: ${functions.length}`);

// ============================================
// 3. 函数复杂度警告 (按行数估算)
// ============================================
console.log('\n📊 函数复杂度警告 (行数 > 50)\n');
const largeFuncs = [];

functions.forEach(f => {
  const start = f.line - 1;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (funcPattern.test(lines[j]) ||
        (arrowPattern.test(lines[j]) && j > start + 1) ||
        modulePattern.test(lines[j])) {
      end = j;
      break;
    }
  }
  const funcLines = end - start;
  if (funcLines > 50) {
    largeFuncs.push({ ...f, lines: funcLines });
  }
});

largeFuncs.sort((a, b) => b.lines - a.lines);
largeFuncs.forEach(f => {
  console.log(`  ⚠️  ${f.name}(): ${f.lines} 行 (L${f.line}) — 建议拆分`);
});

if (largeFuncs.length === 0) {
  console.log('  ✅ 所有函数长度适中');
}

// ============================================
// 4. 错误处理统计
// ============================================
console.log('\n📊 错误处理统计\n');
const tryCount = (source.match(/\btry\s*\{/g) || []).length;
const catchCount = (source.match(/\bcatch\s*\(/g) || []).length;
const emptyCatchCount = (source.match(/catch\s*\(\s*\w+\s*\)\s*\{\s*\}/g) || []).length;
const consoleErrorCount = (source.match(/console\.error\(/g) || []).length;

console.log(`  try 块: ${tryCount}`);
console.log(`  catch 块: ${catchCount}`);
console.log(`  空 catch 块: ${emptyCatchCount}`);
console.log(`  console.error: ${consoleErrorCount}`);

if (emptyCatchCount > 0) {
  console.log(`  ⚠️  发现 ${emptyCatchCount} 个空 catch 块，建议添加注释或 console.debug`);
}

// ============================================
// 5. 魔法数字检测
// ============================================
console.log('\n📊 魔法数字检测 (> 99，非 CONFIG)\n');
const magicNumbers = [];
lines.forEach((line, i) => {
  // 跳过注释行
  if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
  // 跳过 CONFIG 区域
  if (line.includes('CONFIG')) return;

  const matches = line.matchAll(/(?<![\w.>])([1-9]\d{2,})(?![\w])/g);
  for (const m of matches) {
    const num = parseInt(m[1]);
    // 排除常见合理数字
    const commonOk = [100, 200, 300, 400, 500, 600, 768, 1000, 1024];
    if (!commonOk.includes(num)) {
      magicNumbers.push({ line: i + 1, number: num, context: line.trim().slice(0, 80) });
    }
  }
});

const uniqueNums = [...new Set(magicNumbers.map(m => m.number))].sort((a, b) => a - b);
if (uniqueNums.length > 0) {
  console.log(`  可疑魔法数字 (${uniqueNums.length} 种，共 ${magicNumbers.length} 处):`);
  uniqueNums.forEach(n => {
    const count = magicNumbers.filter(m => m.number === n).length;
    console.log(`    ${n} — ${count} 处`);
  });
} else {
  console.log('  ✅ 未发现可疑魔法数字');
}

// ============================================
// 6. DOM 操作分类
// ============================================
console.log('\n📊 DOM 操作统计\n');
const domOps = {
  innerHTML: (source.match(/\.innerHTML\s*=/g) || []).length,
  styleDisplay: (source.match(/\.style\.display\s*=/g) || []).length,
  classList: (source.match(/\.classList\./g) || []).length,
  textContent: (source.match(/\.textContent\s*=/g) || []).length,
  createElement: (source.match(/createElement\(/g) || []).length,
  querySelector: (source.match(/querySelector/g) || []).length,
};

console.log(`  innerHTML 赋值: ${domOps.innerHTML}`);
console.log(`  style.display: ${domOps.styleDisplay}`);
console.log(`  classList 操作: ${domOps.classList}`);
console.log(`  textContent 赋值: ${domOps.textContent}`);
console.log(`  createElement: ${domOps.createElement}`);
console.log(`  querySelector: ${domOps.querySelector}`);

// ============================================
// 总结
// ============================================
console.log('\n📊 代码健康度评分\n');

let score = 100;
const issues = [];

if (emptyCatchCount > 3) { score -= 15; issues.push('空 catch 块过多'); }
else if (emptyCatchCount > 0) { score -= 5; issues.push(`${emptyCatchCount} 个空 catch 块`); }

if (functions.length > 50) { score -= 5; issues.push('函数数量偏多'); }

if (largeFuncs.length > 3) { score -= 10; issues.push(`${largeFuncs.length} 个超长函数`); }
else if (largeFuncs.length > 0) { score -= 3; issues.push(`${largeFuncs.length} 个超长函数`); }

if (domOps.innerHTML > 10) { score -= 5; issues.push('innerHTML 使用频繁'); }

if (score >= 90) console.log(`  评分: ${score}/100 🟢 健康`);
else if (score >= 70) console.log(`  评分: ${score}/100 🟡 一般`);
else console.log(`  评分: ${score}/100 🔴 需要改进`);

if (issues.length > 0) {
  console.log('\n  主要问题:');
  issues.forEach(i => console.log(`    - ${i}`));
}
