/**
 * index.js
 * - Discord Card Bot (cards / money / payments 통합형)
 */

const http = require('http');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');

const storage = require('./storage');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const REGISTER_COMMANDS = (process.env.REGISTER_COMMANDS || 'false').toLowerCase() === 'true';
const PORT = parseInt(process.env.PORT || '3000', 10);

if (!TOKEN || TOKEN.trim().length === 0) {
  console.error('FATAL: TOKEN 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}
if (!CLIENT_ID || CLIENT_ID.trim().length === 0) {
  console.error('FATAL: CLIENT_ID 환경변수가 설정되어 있지 않습니다.');
  process.exit(1);
}

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

function normalizeCard(card) {
  return String(card || '').replace(/-/g, '').trim();
}

function formatCardDisplay(card) {
  const n = normalizeCard(card);
  return n.replace(/(\d{4})(?=\d)/g, '$1-');
}

function parseAmount(raw) {
  const n = parseInt(String(raw || '').replace(/,/g, '').trim(), 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

function kstDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}/${m}/${d}`;
}

const commands = [
  new SlashCommandBuilder()
    .setName('카드등록')
    .setDescription('카드를 등록합니다 (16자리, 하이픈 허용)')
    .addStringOption(opt => opt.setName('번호').setDescription('예: 1234-5678-9012-3456').setRequired(true)),
  new SlashCommandBuilder()
    .setName('카드충전')
    .setDescription('카드에 잔액을 충전합니다')
    .addStringOption(opt => opt.setName('카드번호').setDescription('등록된 카드번호').setRequired(true))
    .addStringOption(opt => opt.setName('금액').setDescription('예: 5000 또는 5,000').setRequired(true)),
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
  try {
    await storage.init();
    console.log('storage initialized at', storage.DATA_FILE);
  } catch (e) {
    console.error('storage init failed:', e);
    process.exit(1);
  }

  await registerGlobalCommands();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === '카드등록') {
        const raw = interaction.options.getString('번호');
        const norm = normalizeCard(raw);

        if (!/^\d{16}$/.test(norm)) {
          return interaction.reply({ content: '카드번호 형식이 잘못되었습니다. 16자리 숫자만 입력해주세요.', ephemeral: true });
        }

        try {
          await storage.setData(data => {
            data.cards = data.cards || {};
            data.money = data.money || {};
            data.payments = data.payments || {};

            data.cards[norm] = { owner: interaction.user.id, display: formatCardDisplay(norm) };
            data.money[norm] = data.money[norm] || 0;
            data.payments[norm] = data.payments[norm] || [];
          });
        } catch (saveErr) {
          console.error('데이터 저장 실패:', saveErr);
          return interaction.reply({ content: '서버 내부 오류: 카드 등록 중 저장에 실패했습니다.', ephemeral: true });
        }

        const balance = storage.get().money?.[norm] || 0;
        return interaction.reply({ content: `카드가 등록되었습니다: **${formatCardDisplay(norm)}** (잔액: ${balance.toLocaleString()}원)` });
      }

      if (interaction.commandName === '카드충전') {
        const norm = normalizeCard(interaction.options.getString('카드번호'));
        const amountNum = parseAmount(interaction.options.getString('금액'));
        const data = storage.get();

        if (!data.cards?.[norm]) {
          return interaction.reply({ content: '등록되지 않은 카드입니다. 먼저 /카드등록 해주세요.', ephemeral: true });
        }

        if (!amountNum) {
          return interaction.reply({ content: '금액 형식이 잘못되었습니다.', ephemeral: true });
        }

        try {
          await storage.setData(d => {
            d.money = d.money || {};
            d.money[norm] = (d.money[norm] || 0) + amountNum;
          });
        } catch (saveErr) {
          console.error('충전 저장 실패:', saveErr);
          return interaction.reply({ content: '서버 내부 오류: 충전 중 저장에 실패했습니다.', ephemeral: true });
        }

        const newBal = storage.get().money?.[norm] || 0;
        return interaction.reply({ content: `충전 완료: **${formatCardDisplay(norm)}**에 ${amountNum.toLocaleString()}원 충전되었습니다. 잔액: ${newBal.toLocaleString()}원` });
      }

      if (interaction.commandName === '결제') {
        const norm = normalizeCard(interaction.options.getString('카드번호'));
        const amountNum = parseAmount(interaction.options.getString('금액'));
        const data = storage.get();

        if (!data.cards?.[norm]) {
          return interaction.reply({ content: '등록되지 않은 카드입니다. 먼저 /카드등록 해주세요.', ephemeral: true });
        }

        if (!amountNum) {
          return interaction.reply({ content: '금액 형식이 잘못되었습니다.', ephemeral: true });
        }

        const currentBalance = data.money?.[norm] || 0;
        if (currentBalance < amountNum) {
          return interaction.reply({ content: `잔액이 부족합니다. 현재 잔액: ${currentBalance.toLocaleString()}원`, ephemeral: true });
        }

        const now = new Date();
        try {
          await storage.setData(d => {
            d.money = d.money || {};
            d.payments = d.payments || {};
            d.money[norm] = (d.money[norm] || 0) - amountNum;
            d.payments[norm] = d.payments[norm] || [];
            d.payments[norm].unshift({ amount: amountNum, timestamp: now.toISOString() });
          });
        } catch (saveErr) {
          console.error('결제 저장 실패:', saveErr);
          return interaction.reply({ content: '서버 내부 오류: 결제 기록 저장 실패', ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle('결제 완료')
          .addFields(
            { name: '카드', value: formatCardDisplay(norm), inline: true },
            { name: '금액', value: `${amountNum.toLocaleString()}원`, inline: true },
            { name: '잔액(결제 후)', value: `${(storage.get().money?.[norm] || 0).toLocaleString()}원`, inline: true },
            { name: '날짜 (KST)', value: kstDateString(now), inline: true }
          )
          .setColor(0x00AE86)
          .setTimestamp(now);

        return interaction.reply({ embeds: [embed] });
      }

      if (interaction.commandName === '결제내역') {
        const norm = normalizeCard(interaction.options.getString('카드번호'));
        const data = storage.get();

        if (!data.cards?.[norm]) {
          return interaction.reply({ content: '등록되지 않은 카드입니다.', ephemeral: true });
        }

        const payments = data.payments?.[norm] || [];
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
            return `• **${(p.amount || 0).toLocaleString()}원** — ${kstDateString(date)}`;
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
          } catch (e) {
            /* ignore */
          }
        });
      }
    } catch (err) {
      console.error('명령 처리 중 오류:', err);
      try {
        await interaction.reply({ content: '서버 내부 오류: 데이터 로드 실패', ephemeral: true });
      } catch (e) {
        /* ignore */
      }
    }
  });

  try {
    await client.login(TOKEN);
  } catch (err) {
    console.error('로그인 실패:', err);
    process.exit(1);
  }

  process.on('SIGINT', async () => {
    console.log('SIGINT 수신, 종료 중...');
    try { await storage.flushAll(); } catch (e) { /* ignore */ }
    try { await client.destroy(); } catch (e) { /* ignore */ }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('SIGTERM 수신, 종료 중...');
    try { await storage.flushAll(); } catch (e) { /* ignore */ }
    try { await client.destroy(); } catch (e) { /* ignore */ }
    process.exit(0);
  });
})();