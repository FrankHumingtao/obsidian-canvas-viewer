import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	ItemView,
	WorkspaceLeaf,
	TFile,
	MarkdownRenderer,
	Notice,
	MarkdownView,
	setIcon,
	Modal,
	normalizePath
} from 'obsidian';

const VIEW_TYPE_CANVAS_VIEWER = 'canvas-viewer-view';

interface CanvasViewerSettings {
	autoOpen: boolean;
	viewPosition: 'right' | 'left';
	enableEdit: boolean;
	defaultEditMode: 'source' | 'preview';
	saveFileLocation: 'current' | 'root' | 'custom';
	customSavePath: string;
}

const DEFAULT_SETTINGS: CanvasViewerSettings = {
	autoOpen: true,
	viewPosition: 'right',
	enableEdit: true,
	defaultEditMode: 'preview',
	saveFileLocation: 'current',
	customSavePath: ''
};

interface CanvasNode {
	id: string;
	type: 'text' | 'file';
	text?: string;
	file?: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
}

interface CanvasData {
	nodes: CanvasNode[];
	edges: any[];
}

export default class CanvasViewerPlugin extends Plugin {
	settings: CanvasViewerSettings;
	private canvasMonitorInterval: number | null = null;
	private lastSelectedNodeId: string | null = null;
	private isViewerEnabled: boolean = false;

	async onload() {
		await this.loadSettings();
		
		// 初始化状态：如果设置了自动打开，则默认为启用
		this.isViewerEnabled = this.settings.autoOpen;

		// 注册视图
		this.registerView(
			VIEW_TYPE_CANVAS_VIEWER,
			(leaf) => new CanvasViewerView(leaf, this)
		);

		// 添加命令:打开 Canvas 查看器
		this.addCommand({
			id: 'open-canvas-viewer',
			name: '打开 Canvas 内容查看器',
			callback: () => {
				this.setViewerEnabled(true);
			}
		});

		// 添加命令:关闭 Canvas 查看器
		this.addCommand({
			id: 'close-canvas-viewer',
			name: '关闭 Canvas 内容查看器',
			callback: () => {
				this.setViewerEnabled(false);
			}
		});

		// 监听 Canvas 视图的激活
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf?.view?.getViewType() === 'canvas') {
					// 注入控制按钮
					this.injectCanvasControl(leaf.view as any);
					
					if (this.isViewerEnabled) {
						// 不抢夺焦点 (reveal=false)
						this.activateView(false);
						this.startMonitoringCanvas();
					}
				} else {
					// 离开 Canvas 时，不需要停止 View，但需要停止监听
					this.stopMonitoringCanvas();
				}
			})
		);
		
		// 初始化处理：等待布局就绪后，扫描所有 Canvas
		this.app.workspace.onLayoutReady(() => {
			this.updateAllCanvasButtons();
			this.cleanupOrphanedTempFiles();
		});

		// 添加设置标签页
		this.addSettingTab(new CanvasViewerSettingTab(this.app, this));

		console.log('Canvas Viewer 插件已加载');
	}

	// 清理残留的临时文件
	async cleanupOrphanedTempFiles() {
		// 使用正则匹配临时文件: "Canvas Node " + 6位字符 + ".md"
		const tempFileRegex = /^Canvas Node [a-z0-9]{6}\.md$/;
		const files = this.app.vault.getFiles();
		
		for (const file of files) {
			// 只检查根目录下的文件 (file.parent.path 为 "/" 或 "")
			const parentPath = file.parent?.path || '';
			if ((parentPath === '/' || parentPath === '') && tempFileRegex.test(file.name)) {
				console.log('清理残留临时文件:', file.path);
				try {
					await this.app.vault.delete(file);
				} catch (e) {
					console.error('清理文件失败:', e);
				}
			}
		}
	}
	
	// 注入 Canvas 控制按钮
	private injectCanvasControl(canvasView: any, retryCount = 0) {
		// 确保是 Canvas 视图
		if (!canvasView || canvasView.getViewType() !== 'canvas') return;
		
		// 查找或创建悬浮按钮容器
		const contentEl = canvasView.contentEl;
		
		// 检查是否已经注入过
		if (contentEl.querySelector('.canvas-viewer-float-btn')) return;
		
		// 创建悬浮按钮
		const btn = contentEl.createEl('div', {
			cls: 'clickable-icon canvas-viewer-float-btn',
			attr: { 'aria-label': '开启/关闭 Canvas 查看器' }
		});
		
		// 设置悬浮样式 - 与右侧原生工具栏对齐
		btn.style.position = 'absolute';
		btn.style.top = '304px';  
		btn.style.right = '8px'; 
		btn.style.zIndex = '10'; 
		btn.style.backgroundColor = 'var(--background-primary)';
		btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
		btn.style.borderRadius = '8px';
		btn.style.padding = '6px';
		btn.style.width = '34px'; //稍微加大一点点
		btn.style.height = '34px';
		btn.style.display = 'flex';
		btn.style.alignItems = 'center';
		btn.style.justifyContent = 'center';
		btn.style.cursor = 'pointer';
		btn.style.transition = 'all 0.2s ease';
		btn.style.border = '1px solid var(--background-modifier-border)';
		
		// 鼠标悬停效果
		btn.onmouseenter = () => {
			btn.style.transform = 'scale(1.1)';
			btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
		};
		btn.onmouseleave = () => {
			btn.style.transform = 'scale(1)';
			btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
		};
		
		// 立即设置图标
		this.updateControlBtnIcon(btn);
		
		btn.addEventListener('click', (e: MouseEvent) => {
			e.stopPropagation();
			this.toggleViewerState(btn);
		});
	}
	
	private updateControlBtnIcon(btn: HTMLElement) {
		// 根据状态设置图标和样式
		// 使用 Lucide 图标
		const iconName = this.isViewerEnabled ? 'message-square-more' : 'message-square-lock'; 
		
		// 清空旧图标
		btn.empty();
		setIcon(btn, iconName);
		
		if (this.isViewerEnabled) {
			btn.addClass('is-active');
			btn.style.color = 'var(--text-on-accent)';
			btn.style.backgroundColor = 'var(--interactive-accent)';
			btn.style.borderColor = 'var(--interactive-accent)';
			btn.setAttribute('aria-label', '关闭查看器');
		} else {
			btn.removeClass('is-active');
			btn.style.color = 'var(--text-muted)';
			btn.style.backgroundColor = 'var(--background-primary)';
			btn.style.borderColor = 'var(--background-modifier-border)';
			btn.setAttribute('aria-label', '开启查看器');
		}
	}
	
	private async toggleViewerState(btn: HTMLElement) {
		const newState = !this.isViewerEnabled;
		await this.setViewerEnabled(newState);
		this.updateControlBtnIcon(btn);
	}
	
	private async setViewerEnabled(enabled: boolean) {
		this.isViewerEnabled = enabled;
		
		// 同步更新设置
		this.settings.autoOpen = enabled;
		await this.saveSettings();
		
		if (enabled) {
			await this.activateView();
			this.startMonitoringCanvas();
			new Notice('Canvas 查看器已开启');
		} else {
			this.stopMonitoringCanvas();
			this.deactivateView();
			new Notice('Canvas 查看器已关闭');
		}
		
		this.updateAllCanvasButtons();
	}
	
	private updateAllCanvasButtons() {
		const leaves = this.app.workspace.getLeavesOfType('canvas');
		leaves.forEach(leaf => {
			const view = leaf.view as any;
			// 尝试注入（如果还没注入）
			if (!view.contentEl.querySelector('.canvas-viewer-float-btn')) {
				this.injectCanvasControl(view);
			} else {
				// 更新状态
				const btn = view.contentEl.querySelector('.canvas-viewer-float-btn') as HTMLElement;
				if (btn) {
					this.updateControlBtnIcon(btn);
				}
			}
		});
	}

	onunload() {
		this.stopMonitoringCanvas();
		this.deactivateView();
		// 清理注入的悬浮按钮
		const buttons = document.querySelectorAll('.canvas-viewer-float-btn');
		buttons.forEach(btn => btn.remove());
		
		console.log('Canvas Viewer 插件已卸载');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateView(reveal = true) {
		const { workspace } = this.app;

		// 检查是否已经打开 - 使用 iterateAllLeaves 确保覆盖所有窗口
		let leaf: WorkspaceLeaf | null = null;
		workspace.iterateAllLeaves((l) => {
			if (l.view.getViewType() === VIEW_TYPE_CANVAS_VIEWER) {
				leaf = l;
				return true; // 找到一个就停止? iterateAllLeaves 的回调返回值好像不支持中断，不过不影响
			}
		});

		if (!leaf) {
			// 在指定位置创建新的 leaf
			const targetLeaf = this.settings.viewPosition === 'right'
				? workspace.getRightLeaf(false)
				: workspace.getLeftLeaf(false);

			if (targetLeaf) {
				await targetLeaf.setViewState({
					type: VIEW_TYPE_CANVAS_VIEWER,
					active: true
				});
				leaf = targetLeaf;
			}
		}

		if (leaf && reveal) {
			workspace.revealLeaf(leaf);
		}
	}

	deactivateView() {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() === VIEW_TYPE_CANVAS_VIEWER) {
				leaves.push(leaf);
			}
		});
		leaves.forEach(leaf => leaf.detach());
	}

	startMonitoringCanvas() {
		this.stopMonitoringCanvas();

		// 每 500ms 检查一次 Canvas 选中状态
		this.canvasMonitorInterval = window.setInterval(() => {
			this.checkCanvasSelection();
		}, 500);
	}

	stopMonitoringCanvas() {
		if (this.canvasMonitorInterval !== null) {
			window.clearInterval(this.canvasMonitorInterval);
			this.canvasMonitorInterval = null;
		}
		this.lastSelectedNodeId = null;
	}

	private async checkCanvasSelection() {
		const activeView = this.app.workspace.getActiveViewOfType(ItemView);
		if (!activeView || activeView.getViewType() !== 'canvas') {
			return;
		}

		try {
			// 尝试获取 Canvas 内部状态
			const canvasView = activeView as any;
			const canvas = canvasView.canvas;

			if (!canvas || !canvas.selection) {
				return;
			}

			// 获取选中的节点
			const selectedNodes = Array.from(canvas.selection) as any[];
			
			if (selectedNodes.length === 0) {
				// 如果之前有选中节点，现在取消了选中（或被删除），需要清理 Viewer
				if (this.lastSelectedNodeId !== null) {
					this.lastSelectedNodeId = null;
					await this.clearAllViewers();
				}
				return;
			}

			// 只处理第一个选中的节点
			const selectedNode = selectedNodes[0];
			
			if (!selectedNode || !selectedNode.id) {
				return;
			}
			
			// 如果选中的节点与上次相同,不重复处理
			if (selectedNode.id === this.lastSelectedNodeId) {
				return;
			}

			this.lastSelectedNodeId = selectedNode.id;

			// 更新查看器内容
			await this.updateViewerContent(selectedNode, canvasView);

		} catch (error) {
			console.error('检查 Canvas 选中状态时出错:', error);
		}
	}

	private async clearAllViewers() {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() === VIEW_TYPE_CANVAS_VIEWER) {
				leaves.push(leaf);
			}
		});

		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof CanvasViewerView) {
				// 如果视图被固定，则不清除
				if (!view.isPinned) {
					await view.clear();
				}
			}
		}
	}

	private async updateViewerContent(node: any, canvasView: any) {
		// 动态获取所有查看器 Leaf (包括浮动窗口中的)
		// 使用 iterateAllLeaves 以确保覆盖所有窗口
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() === VIEW_TYPE_CANVAS_VIEWER) {
				leaves.push(leaf);
			}
		});

		if (leaves.length === 0) {
			return;
		}

		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof CanvasViewerView) {
				// 检查每个视图是否被 Pin
				if (!view.isPinned) {
					await view.displayNodeContent(node, canvasView);
				}
			}
		}
	}
}

class CanvasViewerView extends ItemView {
	plugin: CanvasViewerPlugin;
	private viewContentEl: HTMLElement;
	private currentNode: any = null;
	private currentCanvasView: any = null;
	private editMode: 'source' | 'preview' = 'preview';
	private currentFile: TFile | null = null;
	private embeddedLeaf: WorkspaceLeaf | null = null;
	private temporaryFile: TFile | null = null;
	private fileModifyCallback: ((file: TFile) => void) | null = null;
	public isPinned: boolean = false;
	private pinIconEl: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: CanvasViewerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CANVAS_VIEWER;
	}

	getDisplayText(): string {
		return 'Canvas 内容查看器';
	}

	getIcon(): string {
		return 'file-text';
	}

	async onOpen() {
		// 隐藏默认的视图头部 (icon + title + actions)
		const header = this.containerEl.querySelector('.view-header') as HTMLElement;
		if (header) {
			header.style.display = 'none';
		}

		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('canvas-viewer-container');
		
		// 创建内容区域
		this.viewContentEl = container.createEl('div', { cls: 'canvas-viewer-content' });
		this.showPlaceholder();
	}
	
	// 辅助方法：创建带有图钉的头部
	private createHeaderWithPin(wrapper: HTMLElement, typeText: string, extraText: string = '', openFile: TFile | null = null) {
		const header = wrapper.createEl('div', { cls: 'node-header' });
		const leftContainer = header.createEl('div', { cls: 'node-header-left' });
		
		// 1. 类型
		const info = leftContainer.createEl('div', { cls: 'node-info' });
		info.createEl('strong', { text: typeText });
		
		// 3. 额外文本 (文件名等) - 移到图钉之前，确保显示在左侧
		if (extraText) {
			const nameEl = leftContainer.createEl('div', { cls: 'file-name' });
			nameEl.createEl('span', { text: extraText });
		}

		// 2. 图钉
		const pinBtn = leftContainer.createEl('div', { 
			cls: 'clickable-icon node-pin-btn',
			attr: { 'aria-label': '固定当前视图' }
		});
		
		const updatePinState = () => {
			// 使用 pin 和 pin-off 图标区分状态
			const iconName = this.isPinned ? 'pin' : 'pin-off';
			
			// 清空旧图标
			pinBtn.empty();
			setIcon(pinBtn, iconName);
			
			if (this.isPinned) {
				pinBtn.addClass('is-active');
				pinBtn.setAttribute('aria-label', '取消固定');
			} else {
				pinBtn.removeClass('is-active');
				pinBtn.setAttribute('aria-label', '固定当前视图');
			}
		};
		updatePinState();
		
		pinBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.isPinned = !this.isPinned;
			updatePinState();
			if (this.isPinned) {
				new Notice('Canvas 查看器已固定');
			} else {
				new Notice('Canvas 查看器已取消固定');
			}
		});
		
		// 4. 在新标签页打开按钮
		if (openFile) {
			const openBtn = leftContainer.createEl('div', {
				cls: 'clickable-icon node-open-btn',
				attr: { 'aria-label': '在新标签页中打开' }
			});
			setIcon(openBtn, 'folder-open-dot');
			// openBtn.style.marginLeft = '8px'; // 移除手动 margin，使用 gap 控制
			openBtn.style.opacity = '0.6';
			openBtn.style.cursor = 'pointer';

			// 鼠标悬停效果
			openBtn.onmouseenter = () => openBtn.style.opacity = '1';
			openBtn.onmouseleave = () => openBtn.style.opacity = '0.6';

			openBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.app.workspace.getLeaf('tab').openFile(openFile);
			});
		}
		
		return header;
	}

	async onClose() {
		// 清理嵌入的 Leaf
		if (this.embeddedLeaf) {
			this.embeddedLeaf.detach();
			this.embeddedLeaf = null;
		}
		// 清理文件监听器
		if (this.fileModifyCallback) {
			this.app.vault.off('modify', this.fileModifyCallback);
			this.fileModifyCallback = null;
		}
		// 清理临时文件
		await this.cleanupTemporaryFile();
		
		this.viewContentEl.empty();
	}
	
	async clear() {
		await this.onClose();
		this.showPlaceholder();
		this.currentNode = null;
		this.currentFile = null;
	}

	private async cleanupTemporaryFile() {
		if (this.temporaryFile) {
			try {
				await this.app.vault.delete(this.temporaryFile);
			} catch (e) {
				console.debug('清理临时文件失败(可能已删除):', e);
			}
			this.temporaryFile = null;
		}
	}

	private showPlaceholder() {
		this.viewContentEl.empty();
		this.viewContentEl.createEl('div', {
			cls: 'canvas-viewer-placeholder',
			text: '请在 Canvas 中选择一个文本框或文件节点'
		});
	}

	async displayNodeContent(node: any, canvasView: any) {
		this.viewContentEl.empty();
		this.currentNode = node;
		this.currentCanvasView = canvasView;
		this.editMode = this.plugin.settings.defaultEditMode;

		try {
			// 文本节点
			if (node.text !== undefined) {
				await this.displayTextNode(node);
			}
			// 文件节点
			else if (node.file) {
				await this.displayFileNode(node, canvasView);
			}
			// 链接节点
			else if (node.url) {
				await this.displayLinkNode(node);
			}
			// 组节点 (嵌套 Canvas)
			else if (node.type === 'group') {
				await this.displayGroupNode(node);
			}
			// 其他类型节点
			else {
				this.viewContentEl.createEl('div', {
					cls: 'canvas-viewer-info',
					text: `暂不支持的节点类型: ${node.type || 'unknown'}`
				});
			}
		} catch (error) {
			console.error('显示节点内容时出错:', error);
			this.viewContentEl.createEl('div', {
				cls: 'canvas-viewer-error',
				text: '显示内容时出错'
			});
		}
	}

	private async displayTextNode(node: any) {
		const wrapper = this.viewContentEl.createEl('div', { cls: 'canvas-viewer-text-node' });
		
		// 显示节点信息 (使用新辅助方法)
		const header = this.createHeaderWithPin(wrapper, '文本节点');
		
		// 添加 "保存为 MD" 按钮
		const leftContainer = header.querySelector('.node-header-left');
		if (leftContainer) {
			const saveBtn = leftContainer.createEl('div', {
				cls: 'clickable-icon node-save-btn',
				attr: { 'aria-label': '提取为 Markdown 文件' }
			});
			setIcon(saveBtn, 'file-plus');
			saveBtn.style.opacity = '0.6';
			saveBtn.style.marginLeft = '8px';
			
			saveBtn.addEventListener('click', async (e) => {
				e.stopPropagation();
				await this.saveTextNodeAsFile(node);
			});
			
			// Hover 效果
			saveBtn.onmouseenter = () => saveBtn.style.opacity = '1';
			saveBtn.onmouseleave = () => saveBtn.style.opacity = '0.6';
			
			// 添加 "另存为..." 按钮 (询问文件名)
			const saveAsBtn = leftContainer.createEl('div', {
				cls: 'clickable-icon node-save-as-btn',
				attr: { 'aria-label': '另存为 Markdown 文件...' }
			});
			setIcon(saveAsBtn, 'save');
			saveAsBtn.style.opacity = '0.6';
			saveAsBtn.style.marginLeft = '8px';
			
			saveAsBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				
				// 提取一个默认名
				const defaultName = this.extractDefaultFileName(node.text || '');
				
				new FileNameModal(this.app, defaultName, async (result) => {
					if (result) {
						await this.saveTextNodeAsFile(node, result);
					}
				}).open();
			});
			
			saveAsBtn.onmouseenter = () => saveAsBtn.style.opacity = '1';
			saveAsBtn.onmouseleave = () => saveAsBtn.style.opacity = '0.6';
		}

		// 颜色指示器需要单独处理一下
		
		if (node.color) {
			// 找到 node-info
			const info = header.querySelector('.node-info');
			if (info) {
				info.createEl('span', { 
					cls: 'node-color-indicator',
					attr: { 'data-color': node.color }
				});
			}
		}
		
		const content = wrapper.createEl('div', { cls: 'node-content' });

		// 1. 清理旧的临时文件
		await this.cleanupTemporaryFile();

		// 2. 创建新的临时文件
		// 使用特殊的命名模式，确保唯一且尽可能隐藏
		const tempFileName = `Canvas Node ${node.id.substring(0, 6)}.md`;
		// 尝试在根目录创建，或者放在 .obsidian 文件夹同级（但 Vault 访问受限）
		// 最稳妥是放在根目录，但用户会看到。为了体验，我们接受这一点，或者尝试用隐藏文件夹。
		// 实际上，我们可以利用 Vault 的 adapter 来写入任意位置，但为了用 WorkspaceLeaf 打开，它必须在 Vault 中。
		// 这里我们创建一个临时文件。
		
		try {
			// 检查文件是否已存在（可能是异常残留），存在则删除
			const existingFile = this.app.vault.getAbstractFileByPath(tempFileName);
			if (existingFile) {
				await this.app.vault.delete(existingFile);
			}

			// 创建文件，内容为节点文本
			this.temporaryFile = await this.app.vault.create(tempFileName, node.text || '');
			
			// 3. 使用文件渲染逻辑显示它
			// 传递 isTemporary: true 标志，以便 renderFileContent 知道要建立同步
			await this.renderFileContent(this.temporaryFile, content, true, node);

		} catch (error) {
			console.error('创建临时文件失败:', error);
			content.createEl('div', { 
				cls: 'canvas-viewer-error',
				text: '无法创建编辑环境: ' + error.message
			});
		}
	}

	private extractDefaultFileName(text: string): string {
		let fileName = '未命名笔记';
		// 尝试匹配第一个标题 (# Title)
		const headerMatch = text.match(/^#+\s+(.*)$/m);
		if (headerMatch) {
			fileName = headerMatch[1].trim();
		} else {
			// 如果没有标题，使用第一行非空文本
			const firstLine = text.split('\n').find((line: string) => line.trim().length > 0);
			if (firstLine) {
				fileName = firstLine.trim();
			}
		}
		// 截断过长的文件名
		if (fileName.length > 50) {
			fileName = fileName.substring(0, 50) + '...';
		}
		// 移除非法字符
		fileName = fileName.replace(/[\\/:*?"<>|]/g, '');
		return fileName;
	}

	private async saveTextNodeAsFile(node: any, customFileName: string | null = null) {
		const text = node.text || '';
		if (!text.trim()) {
			new Notice('节点内容为空，无法保存');
			return;
		}

		// 1. 确定文件名
		let fileName = customFileName;
		if (!fileName) {
			fileName = this.extractDefaultFileName(text);
		} else {
			// 确保自定义文件名也是合法的
			fileName = fileName.replace(/[\\/:*?"<>|]/g, '');
		}
		
		// 2. 确定保存路径 (遵循 Obsidian 新建笔记位置设置)
		// getNewFileParent 会根据用户设置（如"当前文件夹"、"指定文件夹"、"根目录"）返回正确的父文件夹
		const sourcePath = this.currentCanvasView?.file?.path || '';
		const folder = this.app.fileManager.getNewFileParent(sourcePath);
		let targetPath = normalizePath(`${folder.path}/${fileName}.md`);
		
		// 3. 处理重名
		let counter = 1;
		while (await this.app.vault.adapter.exists(targetPath)) {
			targetPath = normalizePath(`${folder.path}/${fileName} (${counter}).md`);
			counter++;
		}

		try {
			// 4. 创建文件
			const newFile = await this.app.vault.create(targetPath, text);
			new Notice(`已保存为: ${newFile.basename}`);
			
			// 5. 替换 Canvas 节点
			if (this.currentCanvasView && this.currentCanvasView.canvas) {
				const canvas = this.currentCanvasView.canvas;
				const { x, y, width, height, color } = node;
				
				// 移除旧节点
				canvas.removeNode(node);
				
				// 创建新文件节点
				// @ts-ignore
				const newNode = canvas.createFileNode({
					file: newFile,
					pos: { x, y },
					size: { width, height },
					save: true
				});
				
				// 恢复颜色
				if (color) {
					newNode.setColor(color);
					canvas.requestSave();
				}
				
				// 选中新节点
				canvas.deselectAll();
				if (typeof canvas.select === 'function') {
					canvas.select(newNode);
				} else if (canvas.selection && typeof canvas.selection.add === 'function') {
					canvas.selection.add(newNode);
				}
				canvas.requestSave();
			}
			
		} catch (error) {
			console.error('保存文件失败:', error);
			new Notice('保存文件失败: ' + error.message);
		}
	}

	private async displayFileNode(node: any, canvasView: any) {
		const wrapper = this.viewContentEl.createEl('div', { cls: 'canvas-viewer-file-node' });
		
		// 获取文件对象或路径
		let file: TFile | null = null;
		let filePath = '';
		
		// node.file 可能是 TFile 对象或字符串路径
		if (node.file instanceof TFile) {
			file = node.file;
			filePath = file?.path || '';
		} else if (typeof node.file === 'string') {
			filePath = node.file;
			
			// 如果是相对路径,需要解析
			if (filePath && !filePath.startsWith('/')) {
				const canvasFile = canvasView.file;
				if (canvasFile) {
					const canvasDir = canvasFile.parent?.path || '';
					if (canvasDir) {
						filePath = `${canvasDir}/${filePath}`;
					}
				}
			}
			
			// 尝试获取文件对象
			const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
			if (abstractFile instanceof TFile) {
				file = abstractFile;
			}
		}

		// 检查是否为图片文件
		const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'];
		const isImage = file && imageExtensions.includes(file.extension.toLowerCase());
		
		// 如果是图片，添加特殊类名
		if (isImage) {
			wrapper.addClass('has-image');
		}

		// 确定节点类型名称
		let nodeTypeName = '文件节点';
		if (file) {
			const ext = file.extension.toLowerCase();
			if (ext === 'md') {
				nodeTypeName = '文档节点';
			} else if (ext === 'canvas') {
				nodeTypeName = '白板节点';
			} else if (ext === 'pdf') {
				nodeTypeName = 'PDF 节点';
			} else if (imageExtensions.includes(ext)) {
				nodeTypeName = '图片节点';
			}
		}

		const displayName = file ? file.basename : (typeof node.file === 'string' ? node.file : '未知文件');
		
		// 使用新的 header 创建方法
		this.createHeaderWithPin(wrapper, nodeTypeName, displayName, file);

		// 加载并显示文件内容
		const content = wrapper.createEl('div', { cls: 'node-content' });
		if (file) {
			await this.renderFileContent(file, content);
		} else {
			content.createEl('div', {
				cls: 'canvas-viewer-error',
				text: `文件不存在: ${filePath || '未知路径'}`
			});
		}
	}

	private async displayLinkNode(node: any) {
		const wrapper = this.viewContentEl.createEl('div', { cls: 'canvas-viewer-link-node' });
		
		const header = wrapper.createEl('div', { cls: 'node-header' });
		const info = header.createEl('div', { cls: 'node-info' });
		info.createEl('strong', { text: '网页/链接节点' });
		
		const content = wrapper.createEl('div', { cls: 'node-content' });
		
		// 显示链接信息
		const linkContainer = content.createEl('div', { cls: 'link-container' });
		linkContainer.createEl('div', { text: 'URL: ', cls: 'label' });
		linkContainer.createEl('a', { 
			text: node.url,
			href: node.url,
			cls: 'external-link' 
		});

		// 尝试显示 iframe 预览（如果可能）
		// 注意：很多网站禁止 iframe 嵌入，所以这可能不总是有效
		const iframeContainer = content.createEl('div', { cls: 'iframe-container' });
		iframeContainer.createEl('iframe', {
			attr: {
				src: node.url,
				sandbox: 'allow-forms allow-presentation allow-same-origin allow-scripts allow-modals'
			}
		});
	}

	private async displayGroupNode(node: any) {
		const wrapper = this.viewContentEl.createEl('div', { cls: 'canvas-viewer-group-node' });
		
		const header = wrapper.createEl('div', { cls: 'node-header' });
		const info = header.createEl('div', { cls: 'node-info' });
		info.createEl('strong', { text: '分组 (Group)' });
		if (node.label) {
			info.createEl('span', { text: ` - ${node.label}` });
		}
		
		const content = wrapper.createEl('div', { cls: 'node-content' });
		
		// 显示分组信息
		content.createEl('div', { 
			text: `分组包含 ${node.children?.length || 0} 个子节点`,
			cls: 'group-info' 
		});
		
		// 这里未来可以列出子节点列表
	}

	private async renderFileContent(file: TFile, content: HTMLElement, isTemporary: boolean = false, textNode: any = null) {
		content.empty();
		this.currentFile = file;
		
		const isMd = file.extension === 'md';
		const isCanvas = file.extension === 'canvas';
		const isPdf = file.extension.toLowerCase() === 'pdf';
		
		// MD 和 PDF 使用原生嵌入视图
		const shouldEmbed = isMd || isPdf;
		
		// 如果不需要嵌入但 embeddedLeaf 存在，清理它
		if (!shouldEmbed && this.embeddedLeaf) {
			this.embeddedLeaf.detach();
			this.embeddedLeaf = null;
		}
		
		try {
			if (shouldEmbed) {
				// 使用原生 WorkspaceLeaf 嵌入视图 (仅限 MD)
				content.addClass('native-embed-container');
				content.style.height = '100%'; 
				
				if (!this.embeddedLeaf) {
					// @ts-ignore
					this.embeddedLeaf = new (WorkspaceLeaf as any)(this.app);
				}

				if (this.embeddedLeaf) {
					// 设置打开状态
					const openState: any = { active: false };
					if (isMd) {
						openState.state = { mode: 'source' };
					}
					// PDF 文件不需要特殊的 state，默认即可预览

					await this.embeddedLeaf.openFile(file, openState);

					const view = this.embeddedLeaf.view;
					if (view) {
						content.appendChild(view.containerEl);
						view.containerEl.style.height = '100%';
						view.containerEl.style.width = '100%';
						
						if (isMd && view instanceof MarkdownView) {
							view.editor.refresh();
						}
						view.onResize();
					}
				}

				// 监听临时文件修改 (文本节点)
				if (isTemporary && textNode) {
					if (this.fileModifyCallback) {
						this.app.vault.off('modify', this.fileModifyCallback);
						this.fileModifyCallback = null;
					}

					this.fileModifyCallback = async (modifiedFile: TFile) => {
						if (modifiedFile === file) {
							const newContent = await this.app.vault.read(file);
							if (typeof textNode.setText === 'function') {
								textNode.setText(newContent);
							} else {
								textNode.text = newContent;
								if (typeof textNode.render === 'function') {
									textNode.render();
								} else if (this.currentCanvasView?.canvas?.requestFrame) {
									this.currentCanvasView.canvas.requestFrame();
								}
							}
							this.currentNode.text = newContent;
							if (this.currentCanvasView?.canvas) {
								this.currentCanvasView.canvas.requestSave();
							}
						}
					};
					this.app.vault.on('modify', this.fileModifyCallback);
				}
			} else if (isCanvas) {
				// Canvas 文件：生成 SVG 缩略图
				await this.renderCanvasThumbnail(file, content);
			} else {
				// 其他文件：图片预览或文本预览
				const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'];
				if (imageExtensions.includes(file.extension.toLowerCase())) {
					const imgContainer = content.createEl('div', { cls: 'canvas-viewer-image-container' });
					const img = imgContainer.createEl('img');
					img.src = this.app.vault.getResourcePath(file);
					img.alt = file.basename;
					
					// 启用缩放和平移功能
					this.enableImageZoomAndPan(imgContainer, img);
				} else {
					try {
						const fileContent = await this.app.vault.read(file);
						content.createEl('pre', { text: fileContent });
					} catch (e) {
						content.createEl('div', {
							cls: 'canvas-viewer-info',
							text: `无法预览二进制文件: ${file.extension}`
						});
					}
				}
			}
		} catch (error) {
			console.error("Render error:", error);
			content.createEl('div', {
				cls: 'canvas-viewer-error',
				text: '无法读取或渲染文件内容: ' + error.message
			});
		}
	}

	private async renderCanvasThumbnail(file: TFile, container: HTMLElement) {
		try {
			const content = await this.app.vault.read(file);
			const data = JSON.parse(content);
			
			if (!data.nodes || data.nodes.length === 0) {
				container.createEl('div', { text: '空白白板', cls: 'canvas-viewer-info' });
				return;
			}

			const nodes = data.nodes;
			const edges = data.edges || [];

			// 1. 计算边界
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			nodes.forEach((node: any) => {
				minX = Math.min(minX, node.x);
				minY = Math.min(minY, node.y);
				maxX = Math.max(maxX, node.x + node.width);
				maxY = Math.max(maxY, node.y + node.height);
			});

			// 加上 padding
			const padding = 100;
			minX -= padding;
			minY -= padding;
			maxX += padding;
			maxY += padding;
			const width = maxX - minX;
			const height = maxY - minY;

			// 2. 创建 SVG
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
			svg.setAttribute('width', '100%');
			svg.setAttribute('height', '100%');
			// 保持纵横比
			svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

			// 3. 绘制连线
			edges.forEach((edge: any) => {
				const fromNode = nodes.find((n: any) => n.id === edge.fromNode);
				const toNode = nodes.find((n: any) => n.id === edge.toNode);
				if (fromNode && toNode) {
					const x1 = fromNode.x + fromNode.width / 2;
					const y1 = fromNode.y + fromNode.height / 2;
					const x2 = toNode.x + toNode.width / 2;
					const y2 = toNode.y + toNode.height / 2;

					const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
					line.setAttribute('x1', String(x1));
					line.setAttribute('y1', String(y1));
					line.setAttribute('x2', String(x2));
					line.setAttribute('y2', String(y2));
					line.setAttribute('stroke', '#555'); // 默认深色模式下的灰色
					line.setAttribute('stroke-width', '4');
					line.setAttribute('opacity', '0.5');
					svg.appendChild(line);
				}
			});

			// 4. 绘制节点
			nodes.forEach((node: any) => {
				const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
				rect.setAttribute('x', String(node.x));
				rect.setAttribute('y', String(node.y));
				rect.setAttribute('width', String(node.width));
				rect.setAttribute('height', String(node.height));
				rect.setAttribute('rx', '16'); // 圆角

				// 颜色处理 (模拟 Canvas 颜色)
				let fill = '#333'; // 默认背景色
				const colorMap: any = {
					'1': '#e74c3c', // Red
					'2': '#e67e22', // Orange
					'3': '#f39c12', // Yellow
					'4': '#27ae60', // Green
					'5': '#3498db', // Cyan/Blue
					'6': '#9b59b6'  // Purple
				};

				if (node.color) {
					if (node.color.startsWith('#')) {
						fill = node.color;
					} else if (colorMap[node.color]) {
						fill = colorMap[node.color];
					}
				} else {
					// 根据类型给默认色
					if (node.type === 'text') fill = '#2c3e50';
					else if (node.type === 'file') fill = '#34495e';
					else if (node.type === 'group') fill = 'transparent'; // 分组通常是边框
				}

				rect.setAttribute('fill', fill);
				// 如果是 group，可能只需要边框
				if (node.type === 'group') {
					rect.setAttribute('stroke', '#666');
					rect.setAttribute('stroke-width', '4');
					rect.setAttribute('stroke-dasharray', '10,10');
				} else {
					rect.setAttribute('opacity', '0.8');
				}

				svg.appendChild(rect);
			});

			const wrapper = container.createEl('div', { cls: 'canvas-thumbnail-wrapper' });
			wrapper.appendChild(svg);

		} catch (e) {
			console.error('解析 Canvas 缩略图失败', e);
			container.createEl('div', { text: '预览生成失败', cls: 'canvas-viewer-error' });
		}
	}
	
	// 移除 updateFilePreview，不再需要
	private async updateFilePreview_removed(text: string, previewPane: HTMLElement, file: TFile) {
		// Removed
	}
	// 图片缩放和平移功能
	private enableImageZoomAndPan(container: HTMLElement, img: HTMLImageElement) {
		let scale = 1;
		let panning = false;
		let pointX = 0;
		let pointY = 0;
		let startX = 0;
		let startY = 0;

		// 设置样式
		container.style.overflow = 'hidden';
		container.style.position = 'relative';
		container.style.height = '100%';
		container.style.width = '100%';
		container.style.display = 'flex';
		container.style.alignItems = 'center';
		container.style.justifyContent = 'center';
		
		img.style.transformOrigin = 'center center';
		img.style.transition = 'transform 0.1s ease-out';
		img.style.maxWidth = '100%';
		img.style.maxHeight = '100%';
		img.style.cursor = 'grab';
		
		// 更新变换
		const updateTransform = () => {
			img.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
		};

		// 鼠标滚轮缩放
		container.onwheel = (e) => {
			e.preventDefault();
			const xs = (e.clientX - container.getBoundingClientRect().left - container.offsetWidth / 2) / scale;
			const ys = (e.clientY - container.getBoundingClientRect().top - container.offsetHeight / 2) / scale; // 修正Y轴中心点计算
			
			const delta = e.deltaY > 0 ? 0.9 : 1.1;
			
			// 限制缩放范围
			const newScale = scale * delta;
			if (newScale < 0.5 || newScale > 10) return;
			
			scale = newScale;
			
			// 调整位置以保持鼠标指向的点不变 (简化处理，暂不实现精确鼠标中心缩放，仅中心缩放)
			// 如果需要以鼠标为中心，计算比较复杂，这里先做简单的中心缩放
			// 实际上，简单的中心缩放更符合大多数简易查看器的直觉
			
			updateTransform();
		};

		// 鼠标拖拽
		container.onmousedown = (e) => {
			e.preventDefault();
			startPanning(e.clientX, e.clientY);
		};
		
		// 开始拖拽
		const startPanning = (clientX: number, clientY: number) => {
			panning = true;
			startX = clientX - pointX;
			startY = clientY - pointY;
			img.style.cursor = 'grabbing';
			img.style.transition = 'none'; // 拖拽时禁用过渡，提高响应速度
		};

		// 移动中
		window.onmousemove = (e) => {
			if (!panning) return;
			e.preventDefault();
			pointX = e.clientX - startX;
			pointY = e.clientY - startY;
			updateTransform();
		};

		// 结束拖拽
		window.onmouseup = () => {
			if (panning) {
				panning = false;
				img.style.cursor = 'grab';
				img.style.transition = 'transform 0.1s ease-out'; // 恢复过渡
			}
		};
		
		// 双击重置
		container.ondblclick = () => {
			scale = 1;
			pointX = 0;
			pointY = 0;
			updateTransform();
		};
	}
}

class CanvasViewerSettingTab extends PluginSettingTab {
	plugin: CanvasViewerPlugin;

	constructor(app: App, plugin: CanvasViewerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Canvas Viewer 设置' });

		new Setting(containerEl)
			.setName('自动打开查看器')
			.setDesc('当打开 Canvas 文件时自动打开内容查看器')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoOpen)
				.onChange(async (value) => {
					this.plugin.settings.autoOpen = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('查看器位置')
			.setDesc('设置内容查看器显示在左侧还是右侧')
			.addDropdown(dropdown => dropdown
				.addOption('right', '右侧')
				.addOption('left', '左侧')
				.setValue(this.plugin.settings.viewPosition)
				.onChange(async (value: 'right' | 'left') => {
					this.plugin.settings.viewPosition = value;
					await this.plugin.saveSettings();
					
					// 如果查看器已打开,重新定位
					let hasOpenViewer = false;
					this.plugin.app.workspace.iterateAllLeaves((leaf) => {
						if (leaf.view.getViewType() === VIEW_TYPE_CANVAS_VIEWER) {
							hasOpenViewer = true;
						}
					});
					
					if (hasOpenViewer) {
						this.plugin.deactivateView();
						await this.plugin.activateView();
					}
				}));

		new Setting(containerEl)
			.setName('启用编辑功能')
			.setDesc('允许在查看器中直接编辑文本节点和 MD 文件')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableEdit)
				.onChange(async (value) => {
					this.plugin.settings.enableEdit = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('默认编辑模式')
			.setDesc('点击编辑按钮后默认进入的模式（实时预览）')
			.addDropdown(dropdown => dropdown
				.addOption('preview', '实时预览（推荐）')
				.addOption('source', '源码模式')
				.setValue(this.plugin.settings.defaultEditMode)
				.onChange(async (value: 'source' | 'preview') => {
					this.plugin.settings.defaultEditMode = value;
					await this.plugin.saveSettings();
				}));
	}
}

class FileNameModal extends Modal {
	result: string;
	onSubmit: (result: string) => void;

	constructor(app: App, defaultName: string, onSubmit: (result: string) => void) {
		super(app);
		this.result = defaultName;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h1", { text: "输入文件名" });

		new Setting(contentEl)
			.setName("文件名")
			.addText((text) =>
				text.setValue(this.result).onChange((value) => {
					this.result = value;
				})
			);

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("保存")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(this.result);
				})
		);
		
		// 聚焦输入框
		setTimeout(() => {
			const input = contentEl.querySelector('input');
			if (input) input.focus();
		}, 0);
		
		// 回车提交
		contentEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				this.close();
				this.onSubmit(this.result);
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}