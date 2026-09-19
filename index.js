const fs = require('fs')
const path = require('path')
const { pathToFileURL, fileURLToPath } = require('url')
const { createRequire } = require('module')

// 解决跨盘符软链接导致找不到 koishi 的问题
function resolveKoishi() {
  try {
    return require('koishi')
  } catch (err) {
    if (module.parent && module.parent.filename) {
      try {
        return createRequire(module.parent.filename)('koishi')
      } catch (_) {}
    }
    try {
      return createRequire(path.join(process.cwd(), 'package.json'))('koishi')
    } catch (_) {}
    if (process.env.APPDATA) {
      try {
        const defaultInstancePkg = path.join(
          process.env.APPDATA,
          'Koishi',
          'Desktop',
          'data',
          'instances',
          'default',
          'package.json'
        )
        return createRequire(defaultInstancePkg)('koishi')
      } catch (_) {}
    }
    throw err
  }
}

const { Schema, h } = resolveKoishi()

exports.name = 'local-random-image'

exports.Config = Schema.object({
  baseDir: Schema.string()
    .required()
    .description('本地图库根目录完整路径（例如：D:/Images 或 D:\\图库）'),
  extensions: Schema.array(String)
    .default(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
    .description('支持识别的图片文件后缀'),
  caseInsensitive: Schema.boolean()
    .default(true)
    .description('是否忽略文件夹名称的大小写匹配'),
  cooldown: Schema.natural()
    .default(0)
    .description('群聊单文件夹触发冷却时间（秒，0 表示不限制）'),
  enableAddImage: Schema.boolean()
    .default(true)
    .description('是否启用加图功能（/加图 <名称>）'),
  adminOnly: Schema.boolean()
    .default(false)
    .description('是否仅允许管理员添加图片'),
})

// 根据二进制魔数推断文件真实后缀
function detectImageExtension(buffer) {
  if (!buffer || buffer.length < 4) return '.jpg'
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return '.jpg'
  }
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return '.png'
  }
  // GIF: GIF87a / GIF89a (47 49 46 38)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return '.gif'
  }
  // WEBP: RIFF....WEBP (52 49 46 46 .... 57 45 42 50)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return '.webp'
  }
  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return '.bmp'
  }
  return '.jpg'
}

// 递归遍历所有元素搜集图片/表情源
function collectImageSources(elements) {
  const sources = []
  if (!elements) return sources

  function walk(items) {
    if (!Array.isArray(items)) items = [items]
    for (const item of items) {
      if (!item) continue
      const type = item.type?.toLowerCase()
      if (['img', 'image', 'mface', 'market-face', 'bface'].includes(type)) {
        const src =
          item.attrs?.src ||
          item.attrs?.url ||
          item.attrs?.file ||
          item.attrs?.proxy ||
          item.data?.url ||
          item.data?.file
        if (src && typeof src === 'string') {
          sources.push(src)
        }
      }
      if (item.children && Array.isArray(item.children)) {
        walk(item.children)
      }
    }
  }

  walk(elements)
  return sources
}

exports.apply = function apply(ctx, config) {
  const logger = ctx.logger('local-random-image')
  const cooldownMap = new Map()

  // ----------------------------------------------------
  // 高健壮图片下载器（解决未开代理导致的 ECONNREFUSED 问题）
  // ----------------------------------------------------
  async function fetchImageBuffer(source) {
    if (source.startsWith('base64://')) {
      return Buffer.from(source.slice(9), 'base64')
    }
    if (source.startsWith('data:image/')) {
      const commaIdx = source.indexOf(',')
      if (commaIdx !== -1) {
        return Buffer.from(source.slice(commaIdx + 1), 'base64')
      }
    }

    // 本地缓存文件直接读取
    if (source.startsWith('file://')) {
      try {
        const localPath = fileURLToPath(source)
        if (fs.existsSync(localPath)) {
          return fs.readFileSync(localPath)
        }
      } catch (_) {}
    }

    if (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('/')) {
      if (fs.existsSync(source)) {
        return fs.readFileSync(source)
      }
    }

    // 网络图片下载（优先用原生 fetch，避免被未开启的代理配置阻断）
    if (source.startsWith('http://') || source.startsWith('https://')) {
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: 'https://im.qq.com/',
      }

      try {
        const res = await fetch(source, { headers })
        if (res.ok) {
          const ab = await res.arrayBuffer()
          return Buffer.from(ab)
        }
      } catch (fetchErr) {
        logger.warn(`原生 fetch 下载失败，尝试 ctx.http: ${fetchErr.message}`)
      }

      if (ctx.http) {
        const res = await ctx.http.get(source, {
          responseType: 'arraybuffer',
          headers,
          timeout: 15000,
        })
        return Buffer.from(res)
      }
    }

    throw new Error(`无法识别或无法获取的图片源: ${source.slice(0, 60)}...`)
  }

  // ----------------------------------------------------
  // 核心业务：统一处理「加图」逻辑
  // ----------------------------------------------------
  async function handleAddImage(session, targetName) {
    // 权限检查
    if (config.adminOnly && session.channelId) {
      const isOwnerOrAdmin = session.event?.member?.roles?.some(r =>
        ['owner', 'admin'].includes(r.toLowerCase())
      )
      if (!isOwnerOrAdmin) {
        await session.send('抱歉，当前仅限管理员可以使用加图功能。')
        return true
      }
    }

    // 净化文件夹名称（剥离首尾包裹符号及特殊字符）
    const folderName = targetName
      .replace(/^[<《【「\[\(]+|[>》】」\]\)]+$/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()

    if (!folderName) {
      await session.send('请指定要保存的文件夹名称，例如：/加图 羊宫妃那')
      return true
    }

    // 安全检查：严禁包含路径分隔符、遍历字符和 Windows 非法文件名字符
    if (/[\\/:*?"<>|\0]/.test(folderName) || folderName.includes('..')) {
      await session.send('文件夹名称不合法，请勿包含 / \\ : * ? " < > 等特殊符号。')
      return true
    }

    const baseDir = path.resolve(config.baseDir)
    if (!fs.existsSync(baseDir)) {
      await session.send('图库根目录未配置或不存在，请检查配置。')
      return true
    }

    // ⭐️ 核心保证 1：无论新旧文件夹，均严格位于 baseDir（原有子文件夹所在的同一目录下）
    let matchedFolderName = folderName
    if (config.caseInsensitive) {
      try {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true })
        const lower = folderName.toLowerCase()
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.toLowerCase() === lower) {
            matchedFolderName = entry.name
            break
          }
        }
      } catch (_) {}
    }

    const targetDir = path.join(baseDir, matchedFolderName)

    // 严密检查：目标文件夹的上一级必须严格是 baseDir 本身
    if (path.dirname(targetDir) !== baseDir) {
      await session.send('文件夹路径不合法，必须存放在图库根目录下。')
      return true
    }

    // ⭐️ 核心保证 2：全方位搜集图片来源（同时支持「直接附图」与「引用回复」）
    const targetUrls = []

    // 来源 A：当前消息中附带的图片（直接附图，无论图片在文字前面还是后面）
    const currentSources = collectImageSources(session.elements)
    targetUrls.push(...currentSources)

    // 来源 B：如果本条消息没有图片，从引用的消息中搜集
    if (targetUrls.length === 0) {
      const quoteEl = session.elements?.find(el => el.type === 'quote')

      if (quoteEl?.children?.length) {
        targetUrls.push(...collectImageSources(quoteEl.children))
      }

      if (targetUrls.length === 0 && session.quote) {
        if (session.quote.elements) {
          targetUrls.push(...collectImageSources(session.quote.elements))
        }
        if (targetUrls.length === 0 && session.quote.content) {
          const urlMatches = session.quote.content.match(/https?:\/\/[^\s"'<>]+/g)
          if (urlMatches) targetUrls.push(...urlMatches)
        }
      }

      const quoteId = quoteEl?.attrs?.id || session.quote?.id
      if (targetUrls.length === 0 && quoteId && session.bot?.getMessage) {
        try {
          const msg = await session.bot.getMessage(session.channelId, quoteId)
          if (msg?.elements) {
            targetUrls.push(...collectImageSources(msg.elements))
          }
          if (targetUrls.length === 0 && msg?.content) {
            const urlMatches = msg.content.match(/https?:\/\/[^\s"'<>]+/g)
            if (urlMatches) targetUrls.push(...urlMatches)
          }
        } catch (err) {
          logger.warn(`获取引用消息失败: ${err.message}`)
        }
      }

      // OneBot 协议端底层兜底
      if (targetUrls.length === 0 && quoteId && session.bot?.internal?.getMsg) {
        try {
          const rawMsg = await session.bot.internal.getMsg(Number(quoteId) || quoteId)
          if (rawMsg?.message) {
            const segs = Array.isArray(rawMsg.message) ? rawMsg.message : [rawMsg.message]
            for (const seg of segs) {
              if (['image', 'mface', 'bface'].includes(seg.type)) {
                const u = seg.data?.url || seg.data?.file
                if (u) targetUrls.push(u)
              }
            }
          }
        } catch (_) {}
      }
    }

    const uniqueUrls = Array.from(new Set(targetUrls))

    if (uniqueUrls.length === 0) {
      await session.send(`未检测到图片！请在发送【/加图 ${matchedFolderName}】时同时附带图片，或回复包含图片/表情的消息。`)
      return true
    }

    // ⭐️ 核心保证 3：新图包文件夹自动创建（确保与原有子文件夹处于同一层目录）
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
        logger.info(`[自动新建图包] 已在 ${baseDir} 目录下成功创建新图包文件夹: ${matchedFolderName}`)
      }
    } catch (err) {
      logger.error(`创建新图包文件夹 [${targetDir}] 失败:`, err)
      await session.send('创建图包文件夹失败，请检查文件系统写入权限。')
      return true
    }

    // 下载并存储图片
    let successCount = 0
    for (let i = 0; i < uniqueUrls.length; i++) {
      const imgSource = uniqueUrls[i]
      try {
        logger.info(`正在下载并保存到【${matchedFolderName}】[${i + 1}/${uniqueUrls.length}]: ${imgSource.slice(0, 70)}...`)
        const buffer = await fetchImageBuffer(imgSource)

        const ext = detectImageExtension(buffer)

        // 手机 QQ 规范命名：Image_<13位毫秒时间戳>_<0~999随机数>.<后缀>
        const randSuffix = Math.floor(Math.random() * 1000)
        const filename = `Image_${Date.now()}_${randSuffix}${ext}`
        const destPath = path.join(targetDir, filename)

        fs.writeFileSync(destPath, buffer)
        successCount++
      } catch (err) {
        logger.error(`保存第 ${i + 1} 张图片失败: ${err.message}`)
      }
    }

    // ⭐️ 核心保证 4：严格回复统一的消息文案
    if (successCount > 0) {
      await session.send(`已添加 ${successCount} 张图片到图包：${matchedFolderName}`)
    } else {
      await session.send('图片下载失败，可能是网络问题或图片链接已失效。')
    }
    return true
  }

  // ----------------------------------------------------
  // 方式一：注册 Koishi 指令
  // ----------------------------------------------------
  if (config.enableAddImage) {
    ctx.command('加图 [folder:text]', '下载图片保存到指定图库分类')
      .alias('添加图片', '存图')
      .action(async ({ session }, folder) => {
        // 从 folder 或 elements 中提取干净的名称
        let name = (folder || '')
          .replace(/<[^>]+>/g, '')
          .replace(/^[<《【「\[\(]+|[>》】」\]\)]+$/g, '')
          .trim()

        if (!name && session.elements) {
          for (const el of session.elements) {
            if (el.type === 'text' && el.attrs?.content) {
              const txt = el.attrs.content.replace(/^\s*([/!！／、]?\s*(加图|添加图片|存图))\s*/i, '').trim()
              if (txt) {
                name = txt
                break
              }
            }
          }
        }
        await handleAddImage(session, name)
      })
  }

  // ----------------------------------------------------
  // 方式二：中间件增强（确保图片在前、全角斜杠、或无前缀时也能 100% 触发加图）
  // ----------------------------------------------------
  ctx.middleware(async (session, next) => {
    if (!session.content) return next()

    // 1. 提取纯文本部分（剥离引用、@机器人和所有XML标签）
    const pureText = session.content
      .replace(/<quote[^>]*\/>/g, '')
      .replace(/<at[^>]*\/>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()

    // 2. 检查是否为加图指令（支持 /加图、加图、！加图、附图在文字前等任何排版）
    if (config.enableAddImage) {
      const addMatch = pureText.match(/^[/!！／、]?\s*(?:加图|添加图片|存图)\s+([^\s\r\n]+)/i)
      if (addMatch) {
        const folderName = addMatch[1]
        await handleAddImage(session, folderName)
        return // 终止后续中间件处理
      }
    }

    // 3. 若是以指令符号开头的其他消息，放行
    if (
      pureText.startsWith('/') ||
      pureText.startsWith('!') ||
      pureText.startsWith('／') ||
      pureText.startsWith('！')
    ) {
      return next()
    }

    // ----------------------------------------------------
    // 功能三：关键词随机发送图片
    // ----------------------------------------------------
    if (!pureText || pureText.length > 50 || pureText.includes('\n')) {
      return next()
    }

    // 防路径穿越安全检查
    if (
      pureText.includes('/') ||
      pureText.includes('\\') ||
      pureText.includes('..') ||
      pureText.includes('\0') ||
      pureText.includes(':')
    ) {
      return next()
    }

    const baseDir = path.resolve(config.baseDir)
    if (!fs.existsSync(baseDir)) {
      return next()
    }

    // 查找图库中是否存在对应文件夹
    let matchedFolderName = null
    try {
      if (config.caseInsensitive) {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true })
        const target = pureText.toLowerCase()
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.toLowerCase() === target) {
            matchedFolderName = entry.name
            break
          }
        }
      } else {
        const candidateDir = path.join(baseDir, pureText)
        if (fs.existsSync(candidateDir) && fs.statSync(candidateDir).isDirectory()) {
          matchedFolderName = pureText
        }
      }
    } catch (err) {
      logger.warn('读取图库目录失败:', err)
      return next()
    }

    // 没有对应文件夹，静默放行
    if (!matchedFolderName) {
      return next()
    }

    const targetDir = path.join(baseDir, matchedFolderName)

    // 二次安全防御
    const relativePath = path.relative(baseDir, targetDir)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return next()
    }

    // 冷却时间
    if (config.cooldown > 0 && session.channelId) {
      const cdKey = `${session.channelId}:${matchedFolderName}`
      const lastTime = cooldownMap.get(cdKey) || 0
      const now = Date.now()
      if (now - lastTime < config.cooldown * 1000) {
        return next()
      }
      cooldownMap.set(cdKey, now)
    }

    // 搜集该文件夹下的可用图片
    let files = []
    try {
      const dirEntries = fs.readdirSync(targetDir)
      const allowedExts = config.extensions.map(ext => ext.toLowerCase())
      files = dirEntries.filter(filename => {
        const ext = path.extname(filename).toLowerCase()
        return allowedExts.includes(ext)
      })
    } catch (err) {
      logger.warn(`读取子文件夹 [${matchedFolderName}] 失败:`, err)
      return next()
    }

    if (files.length === 0) {
      return next()
    }

    // 随机选取并发送
    const randomFile = files[Math.floor(Math.random() * files.length)]
    const fullPath = path.join(targetDir, randomFile)

    logger.info(`[命中] 群 ${session.channelId || '私聊'} 触发词 [${pureText}] -> 发送图片: ${randomFile}`)
    try {
      const fileUrl = pathToFileURL(fullPath).href
      await session.send(h.image(fileUrl))
      return
    } catch (err) {
      logger.error(`发送图片 [${fullPath}] 失败，可能受平台群聊风控拦截:`, err)
      return next()
    }
  })
}
