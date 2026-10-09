import React from 'react';
import { Box, Text } from 'ink';
import htm from 'htm';
import { timeReport, formatDuration } from './timer.js';

const html = htm.bind(React.createElement);

function computeStreak(tasks) {
  const doneDates = new Set(
    tasks
      .filter((t) => t.status === 'COMPLETE' && t.doneAt)
      .map((t) => t.doneAt.slice(0, 10)),
  );
  let streak = 0;
  const d = new Date();
  while (doneDates.has(d.toISOString().slice(0, 10))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

export function Dashboard({ data, totalShipped, quote }) {
  const today = new Date().toISOString().slice(0, 10);
  const tasks = data.tasks;

  const streak = computeStreak(tasks);

  const todayWins = tasks.filter(
    (t) => t.status === 'COMPLETE' && t.doneAt?.slice(0, 10) === today,
  );

  const now = Date.now();
  const weekCount = tasks.filter(
    (t) => t.status === 'COMPLETE' && t.doneAt && Date.now() - new Date(t.doneAt) <= 7 * 86400000,
  ).length;
  const monthCount = tasks.filter(
    (t) => t.status === 'COMPLETE' && t.doneAt && Date.now() - new Date(t.doneAt) <= 30 * 86400000,
  ).length;

  const weekTime = timeReport({ scope: 'week' });
  const topProject = Object.entries(weekTime.byProject).sort(([, a], [, b]) => b - a)[0];

  const SEP = html`<${Text} dimColor>${'─'.repeat(44)}<//>`;

  return html`
    <${Box} flexDirection="column" padding=${1} paddingX=${2}>

      <${Box} justifyContent="space-between">
        <${Text}>
          <${Text} color="greenBright" bold>◆ JOI<//><${Text} color="green" bold>  MOMENTUM<//>
        <//>
        <${Text} dimColor>O → liste<//>
      <//>

      <${Box} marginTop=${1}>${SEP}<//>

      <${Box} marginTop=${1} justifyContent="center">
        ${streak > 0
          ? html`<${Text} color="yellow" bold>  🔥  ${streak} GÜN STREAK  <//>`
          : html`<${Text} color="cyan" bold>  ◆  bugün ilk görevi bitir  <//>`
        }
      <//>

      <${Box} marginTop=${2} justifyContent="center">
        <${Box} borderStyle="double" borderColor="greenBright" paddingX=${4}>
          <${Text} color="greenBright" bold>  ${String(totalShipped)}  <//>
        <//>
      <//>
      <${Box} justifyContent="center">
        <${Text} dimColor>tasks shipped all-time<//>
      <//>

      <${Box} marginTop=${1}>${SEP}<//>

      <${Box} marginTop=${1}>
        <${Box} flexDirection="column" width=${16}>
          <${Text} color="greenBright" bold>${todayWins.length}<//>
          <${Text} dimColor>bugün<//>
        <//>
        <${Box} flexDirection="column" width=${16}>
          <${Text} color="greenBright" bold>${weekCount}<//>
          <${Text} dimColor>bu hafta<//>
        <//>
        <${Box} flexDirection="column" width=${16}>
          <${Text} color="greenBright" bold>${monthCount}<//>
          <${Text} dimColor>bu ay<//>
        <//>
      <//>

      ${topProject ? html`
        <${Box} marginTop=${1}>${SEP}<//>
        <${Box} marginTop=${1}>
          <${Text} dimColor>bu hafta en çok  <//>
          <${Text} color="magenta" bold>+${topProject[0]}<//>
          <${Text} dimColor>  ·  ${formatDuration(topProject[1])}<//>
        <//>
      ` : ''}

      <${Box} marginTop=${1}>${SEP}<//>

      ${todayWins.length > 0 ? html`
        <${Box} marginTop=${1}>
          <${Text} color="greenBright" bold>✓  bugün bitirdiklerin<//>
          <${Text} dimColor>  (${todayWins.length})<//>
        <//>
        ${todayWins.slice(0, 10).map((t) => html`
          <${Box} key=${t.id} paddingLeft=${2}>
            <${Text}>
              <${Text} color="green" dimColor>✓  <//>
              <${Text} dimColor>${t.text}<//>
              ${t.project ? html`<${Text} color="magenta" dimColor>  +${t.project}<//>` : ''}
            <//>
          <//>
        `)}
      ` : html`
        <${Box} marginTop=${1} paddingLeft=${2}>
          <${Text} dimColor italic>bugün henüz görev bitmedi — hadi başla<//>
        <//>
      `}

      <${Box} marginTop=${1}>${SEP}<//>

      <${Box} marginTop=${1}>
        <${Text} italic color="yellow">» ${quote}<//>
      <//>

    <//>
  `;
}
