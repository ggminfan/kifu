import { tr } from '../../../../src/shared/i18n';
import { ApplicationMenu } from 'electrobun/bun';
import { subscribeLocale } from '../../../../src/shared/i18n';
import { PRODUCT_NAME } from '../../../../src/shared/brand';

/**
 * Application menu. Edit roles are required for copy/paste in webviews on
 * macOS; tab and sidebar actions are forwarded to the shell.
 */
export function installMenu(actions: Record<string, () => void>): void {
  const render = () => ApplicationMenu.setApplicationMenu([
    {
      submenu: [
        { role: 'about', label: tr`关于 ${PRODUCT_NAME}` },
        { type: 'divider' },
        { label: tr("设置…"), action: 'settings', accelerator: 'CommandOrControl+,' },
        { type: 'divider' },
        { role: 'hide', label: tr`隐藏 ${PRODUCT_NAME}`, accelerator: 'CommandOrControl+H' },
        { role: 'hideOthers', label: tr("隐藏其他"), accelerator: 'CommandOrControl+Shift+H' },
        { role: 'showAll', label: tr("全部显示") },
        { type: 'divider' },
        { role: 'quit', label: tr`退出 ${PRODUCT_NAME}`, accelerator: 'CommandOrControl+Q' },
      ],
    },
    {
      label: tr("文件"),
      submenu: [
        { label: tr("打开工作区…"), action: 'quick-open', accelerator: 'CommandOrControl+T' },
        { label: tr("添加 SSH 主机…"), action: 'add-host' },
        { type: 'divider' },
        { label: tr("关闭标签"), action: 'close-tab', accelerator: 'CommandOrControl+W' },
        { role: 'close', label: tr("关闭窗口"), accelerator: 'CommandOrControl+Shift+W' },
      ],
    },
    {
      label: tr("编辑"),
      submenu: [
        { role: 'undo', label: tr("撤销") },
        { role: 'redo', label: tr("重做") },
        { type: 'divider' },
        { role: 'cut', label: tr("剪切") },
        { role: 'copy', label: tr("拷贝") },
        { role: 'paste', label: tr("粘贴") },
        { role: 'selectAll', label: tr("全选") },
      ],
    },
    {
      label: tr("显示"),
      submenu: [
        { label: tr("显示/隐藏侧边栏"), action: 'toggle-sidebar', accelerator: 'CommandOrControl+B' },
        { label: tr("重新加载当前工作区"), action: 'reload', accelerator: 'CommandOrControl+R' },
        { type: 'divider' },
        { label: tr("下一个标签"), action: 'next-tab', accelerator: 'CommandOrControl+Option+Right' },
        { label: tr("上一个标签"), action: 'prev-tab', accelerator: 'CommandOrControl+Option+Left' },
        { type: 'divider' },
        { role: 'toggleFullScreen', label: tr("进入全屏"), accelerator: 'CommandOrControl+Control+F' },
      ],
    },
    {
      label: tr("窗口"),
      submenu: [
        { role: 'minimize', label: tr("最小化"), accelerator: 'CommandOrControl+M' },
        { role: 'zoom', label: tr("缩放") },
        { type: 'divider' },
        { label: tr("主窗口"), action: 'show-window' },
      ],
    },
    {
      label: tr("帮助"),
      submenu: [
        { label: tr("打开日志目录"), action: 'open-logs' },
        { label: tr("工作区开发者工具"), action: 'devtools' },
      ],
    },
  ]);
  render();
  subscribeLocale(render);
  ApplicationMenu.on('application-menu-clicked', (e) => {
    const action = (e as { data?: { action?: string } }).data?.action;
    if (action && actions[action]) actions[action]();
  });
}
