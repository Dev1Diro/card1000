/**
 * Discord Card Bot (Global commands)
 * Node 18+, discord.js v14
 *
 * 설정: TOKEN, CLIENT_ID 환경변수로 설정하세요.
 * 배포: 글로벌 명령은 등록 후 전파에 시간이 걸립니다 (최대 1시간 이상).
 */

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const fs = require('fs-extra');
const path = require('path');

const TOKEN = process.env.TOKEN || 'YOUR_BOT_TOKEN';
const CLIENT_ID = process.env.CLIENT_ID || 'YOUR_CLIENT_ID';

const DATA_FILE = path.join(__dirname, 'storage.json');

async function loadData() {
  if (!await fs.pathExists(DATA_FILE)) {
    await fs.writeJson(DATA_FILE, { cards: {}, payments: {} }, { spaces: 2 });
  }
  return fs.readJson(DATA_FILE);
}
async function saveData(data) {
  await fs.writeJson(DATA_FILE, data, { spaces: 2 });
}

function normalizeCard(card) {
  return card.replace(/-/g, '').trim();
}
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

(async () => {
  // 글로벌 명령 등록
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('글로벌 명령 등록 중...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('글로벌 명령 등록 요청 전송 완료.');
  } catch (err) {
    console.error('명령 등록 실패:', err);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const data = await loadData();

    if (interaction.commandName === '카드등록') {
      const raw = interaction.options.getString('번호');
      const norm = normalizeCard(raw);
      if (!/^\d{16}$/.test(norm)) {
        return interaction.reply({ content: '카드번호 형식이 잘못되었습니다. 16자리 숫자만 입력해주세요.', ephemeral: true });
      }
      data.cards[norm] = { owner: interaction.user.id, display: formatCardDisplay(norm) };
      if (!data.payments[norm]) data.payments[norm] = [];
      await saveData(data);
      return interaction.reply({ content: `카드가 등록되었습니다: **${formatCardDisplay(norm)}**` });
    }

    if (interaction.commandName === '결제') {
      const rawCard = interaction.options.getString('카드번호');
      const amountRaw = interaction.options.getString('금액');
      const norm = normalizeCard(rawCard);
      if (!data.cards[norm]) {
        return interaction.reply({ content: '등록되지 않은 카드입니다. 먼저 /카드등록 해주세요.', ephemeral: true });
      }
      const amountNum = parseInt(amountRaw.replace(/,/g, '').trim(), 10);
      if (Number.isNaN(amountNum) || amountNum <= 0) {
        return interaction.reply({ content: '금액 형식이 잘못되었습니다.', ephemeral: true });
      }
      const now = new Date();
      const entry = { amount: amountNum, timestamp: now.toISOString() };
      // 최신순: 앞에 추가
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

      // 버튼 (심플)
      const prevBtn = new ButtonBuilder().setCustomId(`prev_${norm}`).setLabel('◀ 이전').setStyle(ButtonStyle.Primary);
      const nextBtn = new ButtonBuilder().setCustomId(`next_${norm}`).setLabel('다음 ▶').setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(prevBtn, nextBtn);

      // 초기 메시지
      let current = 0;
      const message = await interaction.reply({ embeds: [makeEmbedForPage(current)], components: [row], fetchReply: true });

      // 컬렉터: 2분
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 2 * 60 * 1000
      });

      collector.on('collect', async btnInt => {
        // 카드 일치 확인
        if (!btnInt.customId.includes(`_${norm}`)) {
          return btnInt.reply({ content: '이 버튼은 다른 카드의 내역용입니다.', ephemeral: true });
        }
        // 페이지 변경 (순환)
        if (btnInt.customId.startsWith('prev_')) {
          current = (current - 1 + totalPages) % totalPages;
        } else {
          current = (current + 1) % totalPages;
        }
        await btnInt.update({ embeds: [makeEmbedForPage(current)], components: [row] });
      });

      collector.on('end', async () => {
        // 버튼 비활성화
        try {
          const disabledRow = new ActionRowBuilder().addComponents(
            prevBtn.setDisabled(true),
            nextBtn.setDisabled(true)
          );
          await message.edit({ components: [disabledRow] });
        } catch (e) {
          // 무시
        }
      });
    }
  });

  client.login(TOKEN);
})();