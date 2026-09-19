import { Context, Schema, h } from 'koishi'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL, fileURLToPath } from 'url'

export const name = 'local-random-image'

export interface Config {
  baseDir: string
  extensions: string[]
  caseInsensitive: boolean
  cooldown: number
  enableAddImage: boolean
  adminOnly: boolean
}

export const Config: Schema<Config> = Schema.object({
  baseDir: Schema.string()
    .description('本地图库根目录完整路径（支持任意盘符，例如：D:/Images 或 D:\\图库）')
    .required(),
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

function detectImageExtension(buffer: Buffer): string {
  if (!buffer || buffer.length < 4) return '.jpg'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return '.gif'
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
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp'
  return '.jpg'
}

function collectImageSources(elements: any): string[] {
  const sources: string[] = []
  if (!elements) return sources

  function walk(items: any) {
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

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('local-random-image')
  const cooldownMap = new Map<string, number>()

  async function fetchImageBuffer(source: string): Promise<Buffer> {
    if (source.startsWith('base64://')) {
      return Buffer.from(source.slice(9), 'base64')
    }
    if (source.startsWith('data:image/')) {
      const commaIdx = source.indexOf(',')
      if (commaIdx !== -1) {
        return Buffer.from(source.slice(commaIdx + 1), 'base64')
      }
    }

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
      } catch (fetchErr: any) {
        logger.warn(`原生 fetch 下载失败，尝试 ctx.http: ${fetchErr.message}`)
      }

      if (ctx.http) {
        const res = await ctx.http.get<ArrayBuffer>(source, {
          responseType: 'arraybuffer',
          headers,
          timeout: 15000,
        })
        return Buffer.from(res)
      }
    }

    throw new Error(`无法识别或无法获取的图片源: ${source.slice(0, 60)}...`)
  }

  async function handleAddImage(session: any, targetName: string) {
    if (config.adminOnly && session.channelId) {
      const isOwnerOrAdmin = session.event?.member?.roles?.some((r: string) =>
        ['owner', 'admin'].includes(r.toLowerCase())
      )
      if (!isOwnerOrAdmin) {
        await session.send('抱歉，当前仅限管理员可以使用加图功能。')
        return true
      }
    }

    const folderName = (targetName || '')
      .replace(/^[<《【「\[\(]+|[>》】」\]\)]+$/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()

    if (!folderName) {
      await session.send('请指定要保存的文件夹名称，例如：/加图 羊宫妃那')
      return true
    }

    if (/[\\/:*?"<>|\0]/.test(folderName) || folderName.includes('..')) {
      await session.send('文件夹名称不合法，请勿包含 / \\ : * ? " < > 等特殊符号。')
      return true
    }

    const baseDir = path.resolve(config.baseDir)
    if (!fs.existsSync(baseDir)) {
      await session.send('图库根目录未配置或不存在，请检查配置。')
      return true
    }

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

    if (path.dirname(targetDir) !== baseDir) {
      await session.send('文件夹路径不合法，必须存放在图库根目录下。')
      return true
    }

    const targetUrls: string[] = []

    const currentSources = collectImageSources(session.elements)
    targetUrls.push(...currentSources)

    if (targetUrls.length === 0) {
      const quoteEl = session.elements?.find((el: any) => el.type === 'quote')

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
        } catch (err: any) {
          logger.warn(`获取引用消息失败: ${err.message}`)
        }
      }

      if (targetUrls.length === 0 && quoteId && (session.bot as any)?.internal?.getMsg) {
        try {
          const rawMsg = await (session.bot as any).internal.getMsg(Number(quoteId) || quoteId)
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

    let successCount = 0
    for (let i = 0; i < uniqueUrls.length; i++) {
      const imgSource = uniqueUrls[i]
      try {
        logger.info(`正在下载并保存到【${matchedFolderName}】[${i + 1}/${uniqueUrls.length}]: ${imgSource.slice(0, 70)}...`)
        const buffer = await fetchImageBuffer(imgSource)

        const ext = detectImageExtension(buffer)

        const randSuffix = Math.floor(Math.random() * 1000)
        const filename = `Image_${Date.now()}_${randSuffix}${ext}`
        const destPath = path.join(targetDir, filename)

        fs.writeFileSync(destPath, buffer)
        successCount++
      } catch (err: any) {
        logger.error(`保存第 ${i + 1} 张图片失败: ${err.message}`)
      }
    }

    if (successCount > 0) {
      await session.send(`已添加 ${successCount} 张图片到图包：${matchedFolderName}`)
    } else {
      await session.send('图片下载失败，可能是网络问题或图片链接已失效。')
    }
    return true
  }

  if (config.enableAddImage) {
    ctx.command('加图 [folder:text]', '下载图片保存到指定图库分类')
      .alias('添加图片', '存图')
      .action(async ({ session }, folder) => {
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

  ctx.middleware(async (session, next) => {
    if (!session.content) return next()

    const pureText = session.content
      .replace(/<quote[^>]*\/>/g, '')
      .replace(/<at[^>]*\/>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()

    if (config.enableAddImage) {
      const addMatch = pureText.match(/^[/!！／、]?\s*(?:加图|添加图片|存图)\s+([^\s\r\n]+)/i)
      if (addMatch) {
        const folderName = addMatch[1]
        await handleAddImage(session, folderName)
        return
      }
    }

    if (
      pureText.startsWith('/') ||
      pureText.startsWith('!') ||
      pureText.startsWith('／') ||
      pureText.startsWith('！')
    ) {
      return next()
    }

    if (!pureText || pureText.length > 50 || pureText.includes('\n')) {
      return next()
    }

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

    let matchedFolderName: string | null = null
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

    if (!matchedFolderName) {
      return next()
    }

    const targetDir = path.join(baseDir, matchedFolderName)

    const relativePath = path.relative(baseDir, targetDir)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return next()
    }

    if (config.cooldown > 0 && session.channelId) {
      const cdKey = `${session.channelId}:${matchedFolderName}`
      const lastTime = cooldownMap.get(cdKey) || 0
      const now = Date.now()
      if (now - lastTime < config.cooldown * 1000) {
        return next()
      }
      cooldownMap.set(cdKey, now)
    }

    let files: string[] = []
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
