/**
 * Discord Card Bot - 안정화 버전 (Render 친화적)
 *
 * 필수 환경변수:
 *   TOKEN         - Discord Bot Token
 *   CLIENT_ID     - Application (Client) ID
 *
 * 선택 환경변수:
 *   REGISTER_COMMANDS - "true"로 설정하면 글로벌 명령을 등록 (한 번만 실행 권장)
 *   DATA_FILE         - 저장 파일 경로 (절대경로 권장). 기본: ./storage.json
 *   PORT              - HTTP 포트 (Render Web Service용). 기본: 3000
 *
 * 변경 요약:
 * - 디렉터리 보장 및 절대경로 사용
 * - 빈 파일 처리 및 파싱 실패 시 안전 복구
 * - atomic write (tmp 파일) + 재시도 로직
 * - save queue 오버플로우 방지
 */

const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const { dirname } = require('path');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const REGISTER_COMMANDS = (process.env.REGISTER_COMMANDS || 'false').toLowerCase() === 'true';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'storage.json');
const PORT = parseInt(process.env.PORT || '3000', 10);

// 환경변수 검사
if (!TOKEN || TOKEN.trim().length === 0) {
  console.error('FATAL: TOKEN 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}
if (!CLIENT_ID || CLIENT_ID.trim().length === 0) {
  console.error('FATAL: CLIENT_ID 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}

// 간단한 HTTP 서버 (Render Web Service에서 포트 검사 통과용)
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// --- 안전한 데이터 저장 로직 ---
const saveQueue = [];
let saving = false;

// atomic write: tmp 파일에 쓰고 이동
async function atomicWriteJson(filePath, data) {
  const resolved = path.resolve(filePath);
  await fs.ensureDir(path.dirname(resolved));
  const tmp = `${resolved}.tmp.${Date.now()}`;
  await fs.writeJson(tmp, data, { spaces: 2, encoding: 'utf8' });
  await fs.move(tmp, resolved, { overwrite: true });
}

// enqueueSave: 큐 길이 제한 및 안정적 처리
async function enqueueSave(data) {
  return new Promise((resolve, reject) => {
    if (saveQueue.length > 1000) {
      return reject(new Error('save queue overflow'));
    }
    saveQueue.push({ data, resolve, reject });
    // processSaveQueue 내부에서 동시 실행을 막음
    processSaveQueue().catch(err => {
      console.error('processSaveQueue error:', err);
    });
  });
}

async function processSaveQueue() {
  if (saving) return;
  saving = true;
  while (saveQueue.length > 0) {
    const { data, resolve, reject } = saveQueue.shift();
    try {
      await atomicWriteJson(DATA_FILE, data);
      resolve();
    } catch (err) {
      console.error('atomicWriteJson 실패:', err);
      // 간단한 재시도(지연 후 1회)
      try {
        await new Promise(r => setTimeout(r, 200));
        await atomicWriteJson(DATA_FILE, data);
        resolve();
      } catch (err2) {
        console.error('재시도 실패:', err2);
        reject(err2);
      }
    }
  }
  saving = false;
}

// loadData: 파일 없으면 생성, 빈 파일/파싱 실패 시 복구
async function loadData() {
  try {
    const resolved = path.resolve(DATA_FILE);
    await fs.ensureDir(path.dirname(resolved));

    if (!await fs.pathExists(resolved)) {
      const init = { cards: {}, payments: {} };
      await atomicWriteJson(resolved, init);
      console.log(`데이터 파일 생성: ${resolved}`);
      return init;
    }

    const stats = await fs.stat(resolved);
    if (stats.size === 0) {
      console.warn('데이터 파일이 비어있습니다. 초기화합니다.');
      const init = { cards: {}, payments: {} };
      await atomicWriteJson(resolved, init);
      return init;
    }

    const raw = await fs.readFile(resolved, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      parsed.cards = parsed.cards || {};
      parsed.payments = parsed.payments || {};
      return parsed;
    } catch (parseErr) {
      console.error('데이터 파일 파싱 실패:', parseErr);
      const bak = `${resolved}.corrupt.${Date.now()}`;
      await fs.copy(resolved, bak);
      console.warn(`손상된 데이터 파일을 백업했습니다: ${bak}`);
      const init = { cards: {}, payments: {} };
      await atomicWriteJson(resolved, init);
      console.log('데이터 파일을 초기화했습니다.');
      return init;
    }
  } catch (err) {
    console.error('데이터 파일 로드 중 예외:', err);
    try {
      const init = { cards: {}, payments: {} };
      await atomicWriteJson(path.resolve(DATA_FILE), init);
      console.log('데이터 파일을 강제 초기화했습니다.');
      return init;
    } catch (err2) {
      console.error('강제 초기화 실패:', err2);
      throw err2;
    }
  }
}

// 유틸
function normalizeCard(card) { return String(card).replace(/-/g, '').trim(); }
function formatCardDisplay(card) {
  const n = normalizeCard(card);
  return n.replace(/(\d{4})(?=\d)/g, '$1-');
}
function kstDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}/${m}/${d}`;
}

// 슬래시 명령 정의
const commands = [
  new SlashCommandBuilder()
    .setName('카드등록')
    .setDescription('카드를 등록합니다 (16자리, 하이픈 허용)')
    .addStringOption(opt => opt.setName('번호').setDescription('예: 1234-5678-9012-3456').setRequired(true)),
  new SlashCommandBuilder()
    .setName('결제')
    .setDescription('카드로 결제합니다')
    .addStringOption(opt => opt.setName('카드번호').setDescription('등록된 카드번호').setRequired(true))
    .addStringOption(opt => opt.setName('금액').setDescription('예: 5000 또는 5,000').setRequired(true)),
  new SlashCommandBuilder()
    .setName('결제내역')
    .setDescription('해당 카드의 결제내역을 봅니다')
    .addStringOption(opt => opt.setName('카드번호').setDescription('등록된 카드번호').setRequired(true))
].map(c => c.toJSON());

// 글로벌 명령 등록 (선택)
async function registerGlobalCommands() {
  if (!REGISTER_COMMANDS) {
    console.log('글로벌 명령 등록 비활성화 (REGISTER_COMMANDS != true)');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('글로벌 명령 등록 시작...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('글로벌 명령 등록 요청 전송 완료.');
  } catch (err) {
    console.error('명령 등록 실패:', err);
  }
}

(async () => {
  await registerGlobalCommands();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    let data;
    try {
      data = await loadData();
    } catch (err) {
      console.error('loadData 실패:', err);
      return interaction.reply({ content: '서버 내부 오류: 데이터 로드 실패', ephemeral: true });
    }

    try {
      if (interaction.commandName === '카드등록') {
        const raw = interaction.options.getString('번호');
        const norm = normalizeCard(raw);
        if (!/^\d{16}$/.test(norm)) {
          return interaction.reply({ content: '카드번호 형식이 잘못되었습니다. 16자리 숫자만 입력해주세요.', ephemeral: true });
        }
        data.cards[norm] = { owner: interaction.user.id, display: formatCardDisplay(norm) };
        if (!data.payments[norm]) data.payments[norm] = [];
        try {
          await enqueueSave(data);
        } catch (saveErr) {
          console.error('데이터 저장 실패:', saveErr);
          return interaction.reply({ content: '서버 내부 오류: 카드 등록 중 저장에 실패했습니다.', ephemeral: true });
        }
        return interaction.reply({ content: `카드가 등록되었습니다: **${formatCardDisplay(norm)}**` });
      }

      if (interaction.commandName === '결제') {
        const rawCard = interaction.options.getString('카드번호');
        const amountRaw = interaction.options.getString('금액');
        const norm = normalizeCard(rawCard);
        if (!data.cards[norm]) {
          return interaction.reply({ content: '등록되지 않은 카드입니다. 먼저 /카드등록 해주세요.', ephemeral: true });
        }
        const amountNum = parseInt(String(amountRaw).replace(/,/g, '').trim(), 10);
        if (Number.isNaN(amountNum) || amountNum <= 0) {
          return interaction.reply({ content: '금액 형식이 잘못되었습니다.', ephemeral: true });
        }
        const now = new Date();
        const entry = { amount: amountNum, timestamp: now.toISOString() };
        data.payments[norm] = data.payments[norm] || [];
        data.payments[norm].unshift(entry); // 최신순
        try {
          await enqueueSave(data);
        } catch (saveErr) {
          console.error('데이터 저장 실패:', saveErr);
          return interaction.reply({ content: '서버 내부 오류: 결제 기록 저장 실패', ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle('결제 완료')
          .addFields(
            { name: '카드', value: formatCardDisplay(norm), inline: true },
            { name: '금액', value: `${amountNum.toLocaleString()}원`, inline: true },
            { name: '날짜 (KST)', value: kstDateString(now), inline: true }
          )
          .setColor(0x00AE86)
          .setTimestamp(now);

        return interaction.reply({ embeds: [embed] });
      }

      if (interaction.commandName === '결제내역') {
        const rawCard = interaction.options.getString('카드번호');
        const norm = normalizeCard(rawCard);
        if (!data.cards[norm]) {
          return interaction.reply({ content: '등록되지 않은 카드입니다.', ephemeral: true });
        }
        const payments = data.payments[norm] || [];
        if (payments.length === 0) {
          return interaction.reply({ content: '결제 내역이 없습니다.', ephemeral: true });
        }

        const pageSize = 10;
        const totalPages = Math.max(1, Math.ceil(payments.length / pageSize));
        const totalAmount = payments.reduce((s, p) => s + (p.amount || 0), 0);

        function makeEmbedForPage(pageIndex) {
          const start = pageIndex * pageSize;
          const slice = payments.slice(start, start + pageSize);
          const embed = new EmbedBuilder()
            .setTitle(`결제내역 — ${formatCardDisplay(norm)}`)
            .setColor(0x0099ff);

          const desc = slice.map(p => {
            const date = new Date(p.timestamp);
            return `• **${p.amount.toLocaleString()}원** — ${kstDateString(date)}`;
          }).join('\n');

          embed.setDescription(desc || '내역 없음');
          embed.setFooter({ text: `총 사용액: ${totalAmount.toLocaleString()}원 | 페이지 ${pageIndex + 1}/${totalPages}` });
          return embed;
        }

        const prevBtn = new ButtonBuilder().setCustomId(`prev_${norm}`).setLabel('◀ 이전').setStyle(ButtonStyle.Primary);
        const nextBtn = new ButtonBuilder().setCustomId(`next_${norm}`).setLabel('다음 ▶').setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder().addComponents(prevBtn, nextBtn);

        let current = 0;
        const message = await interaction.reply({ embeds: [makeEmbedForPage(current)], components: [row], fetchReply: true });

        const collector = message.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 2 * 60 * 1000
        });

        collector.on('collect', async btnInt => {
          if (!btnInt.customId.includes(`_${norm}`)) {
            return btnInt.reply({ content: '이 버튼은 다른 카드의 내역용입니다.', ephemeral: true });
          }
          if (btnInt.customId.startsWith('prev_')) {
            current = (current - 1 + totalPages) % totalPages;
          } else {
            current = (current + 1) % totalPages;
          }
          await btnInt.update({ embeds: [makeEmbedForPage(current)], components: [row] });
        });

        collector.on('end', async () => {
          try {
            const disabledRow = new ActionRowBuilder().addComponents(
              prevBtn.setDisabled(true),
              nextBtn.setDisabled(true)
            );
            await message.edit({ components: [disabledRow] });
          } catch (e) { /* 무시 */ }
        });
      }
    } catch (err) {
      console.error('명령 처리 중 오류:', err);
      try { await interaction.reply({ content: '명령 처리 중 오류가 발생했습니다.', ephemeral: true }); } catch (e) { /* 무시 */ }
    }
  });

  // 안전한 로그인
  try {
    await client.login(TOKEN);
  } catch (err) {
    console.error('로그인 실패: 토큰이 유효하지 않거나 네트워크 오류가 발생했습니다.', err);
    process.exit(1);
  }

  // 프로세스 종료 시 안전 처리
  process.on('SIGINT', async () => {
    console.log('SIGINT 수신, 종료 중...');
    try { await client.destroy(); } catch (e) { /* 무시 */ }
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    console.log('SIGTERM 수신, 종료 중...');
    try { await client.destroy(); } catch (e) { /* 무시 */ }
    process.exit(0);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
  });
})();