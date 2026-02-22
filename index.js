/**
 * 안정화된 Discord Card Bot (포트 바인딩 포함)
 * Node 18+, discord.js v14
 *
 * 필수 환경변수: TOKEN, CLIENT_ID
 * 선택 환경변수: REGISTER_COMMANDS=true, DATA_FILE=/path/to/storage.json, PORT
 */

const http = require('http');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const fs = require('fs-extra');
const path = require('path');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const REGISTER_COMMANDS = (process.env.REGISTER_COMMANDS || 'false').toLowerCase() === 'true';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'storage.json');
const PORT = process.env.PORT || 3000;

// 환경변수 검사
if (!TOKEN || TOKEN.trim().length === 0) {
  console.error('FATAL: TOKEN 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}
if (!CLIENT_ID || CLIENT_ID.trim().length === 0) {
  console.error('FATAL: CLIENT_ID 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}

// 간단한 HTTP 서버: Render 같은 플랫폼에서 포트 검사 통과용
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// 데이터 파일 초기화/로딩
async function loadData() {
  try {
    if (!await fs.pathExists(DATA_FILE)) {
      await fs.ensureFile(DATA_FILE);
      await fs.writeJson(DATA_FILE, { cards: {}, payments: {} }, { spaces: 2 });
      console.log(`데이터 파일 생성: ${DATA_FILE}`);
    }
    return await fs.readJson(DATA_FILE);
  } catch (err) {
    console.error('데이터 파일 로드 실패:', err);
    throw err;
  }
}
async function saveData(data) {
  try {
    await fs.writeJson(DATA_FILE, data, { spaces: 2 });
  } catch (err) {
    console.error('데이터 저장 실패:', err);
    throw err;
  }
}

function normalizeCard(card) { return card.replace(/-/g, '').trim(); }
function formatCardDisplay(card) { const n = normalizeCard(card); return n.replace(/(\d{4})(?=\d)/g, '$1-'); }
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

  // 주의: discord.js v14에서는 'ready' 이벤트 사용. v15에서 'clientReady'로 변경 예정이라는 경고가 뜰 수 있음.
  client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    let data;
    try { data = await loadData(); } catch (err) {
      return interaction.reply({ content: '서버 내부 오류: 데이터 로드 실패', ephemeral: true });
    }

    try {
      if (interaction.commandName === '카드등록') {
        const raw = interaction.options.getString('번호');
        const norm = normalizeCard(raw);
        if (!/^\d{16}$/.test(norm)) return interaction.reply({ content: '카드번호 형식이 잘못되었습니다. 16자리 숫자만 입력해주세요.', ephemeral: true });
        data.cards[norm] = { owner: interaction.user.id, display: formatCardDisplay(norm) };
        if (!data.payments[norm]) data.payments[norm] = [];
        await saveData(data);
        return interaction.reply({ content: `카드가 등록되었습니다: **${formatCardDisplay(norm)}**` });
      }

      if (interaction.commandName === '결제') {
        const rawCard = interaction.options.getString('카드번호');
        const amountRaw = interaction.options.getString('금액');
        const norm = normalizeCard(rawCard);
        if (!data.cards[norm]) return interaction.reply({ content: '등록되지 않은 카드입니다. 먼저 /카드등록 해주세요.', ephemeral: true });
        const amountNum = parseInt(amountRaw.replace(/,/g, '').trim(), 10);
        if (Number.isNaN(amountNum) || amountNum <= 0) return interaction.reply({ content: '금액 형식이 잘못되었습니다.', ephemeral: true });
        const now = new Date();
        const entry = { amount: amountNum, timestamp: now.toISOString() };
        data.payments[norm] = data.payments[norm] || [];
        data.payments[norm].unshift(entry);
        await saveData(data);

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
        if (!data.cards[norm]) return interaction.reply({ content: '등록되지 않은 카드입니다.', ephemeral: true });
        const payments = data.payments[norm] || [];
        if (payments.length === 0) return interaction.reply({ content: '결제 내역이 없습니다.', ephemeral: true });

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
          if (!btnInt.customId.includes(`_${norm}`)) return btnInt.reply({ content: '이 버튼은 다른 카드의 내역용입니다.', ephemeral: true });
          if (btnInt.customId.startsWith('prev_')) current = (current - 1 + totalPages) % totalPages;
          else current = (current + 1) % totalPages;
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

  try {
    await client.login(TOKEN);
  } catch (err) {
    console.error('로그인 실패: 토큰이 유효하지 않거나 네트워크 오류가 발생했습니다.', err);
    process.exit(1);
  }
})();