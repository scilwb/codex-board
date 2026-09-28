const toast = document.querySelector('.toast');
let toastTimer;
function announce(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3800);
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); }
  catch {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('copy unavailable');
  }
}
const projectNames = { all: '全部对话', yam: 'YAM', behavior: 'BEHAVIOR' };
document.querySelectorAll('[data-project]').forEach(button => {
  button.addEventListener('click', () => {
    const project = button.dataset.project;
    document.querySelectorAll('[data-project]').forEach(tab => {
      tab.classList.toggle('selected', tab === button);
      tab.setAttribute('aria-pressed', String(tab === button));
    });
    document.querySelector('.canvas').dataset.filter = project;
    document.querySelectorAll('[data-card-project]').forEach(card => {
      const hidden = project !== 'all' && card.dataset.cardProject !== project;
      card.classList.toggle('muted', hidden);
      card.inert = hidden;
      card.setAttribute('aria-hidden', String(hidden));
    });
    document.querySelector('#demo-title').textContent = projectNames[project];
    document.querySelector('#demo-count').textContent = project === 'all' ? '4' : '2';
    document.querySelector('#demo-hint').textContent = project === 'all'
      ? '不同方向，各有位置；前后关系，一眼可见。'
      : `${projectNames[project]} · 按研究方向归类，不受文件夹边界限制。`;
  });
});
document.querySelectorAll('[data-copy-id]').forEach(button => {
  button.addEventListener('click', async () => {
    try {
      await copyText(button.dataset.copyId);
      announce('已复制演示会话 ID。此 ID 不对应真实会话。');
    } catch { announce('浏览器未允许复制，请在本机应用中使用复制 ID。'); }
  });
});
document.querySelectorAll('[data-demo-open]').forEach(button => {
  button.addEventListener('click', () => announce('这是交互演示。安装 Board 与桥接后，即可定位 VS Code 对话。'));
});
document.querySelectorAll('[data-copy-target]').forEach(button => {
  let restoreTimer;
  button.addEventListener('click', async () => {
    try {
      await copyText(document.getElementById(button.dataset.copyTarget).textContent);
      const label = button.querySelector('span');
      const icon = button.querySelector('use');
      clearTimeout(restoreTimer);
      label.textContent = '已复制';
      icon.setAttribute('href', '#check');
      announce('安装命令已复制。');
      restoreTimer = setTimeout(() => {
        label.textContent = '复制命令';
        icon.setAttribute('href', '#copy');
      }, 2600);
    } catch { announce('复制未成功，请选择上方命令手动复制。'); }
  });
});
const dialog = document.querySelector('#screenshot-dialog');
document.querySelector('#show-screenshot').addEventListener('click', () => dialog.showModal());
document.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
