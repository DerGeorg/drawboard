package at.dergeorg.drawboard.files.domain.images

import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.channels.SeekableByteChannel
import javax.imageio.IIOImage
import javax.imageio.ImageIO
import javax.imageio.ImageWriteParam
import javax.imageio.stream.ImageInputStream
import kotlin.math.max

/** A made thumbnail: [data] is a complete image file of [mediaType], re-encoded without any metadata of the source. */
internal class Thumbnail(val mediaType: String, val data: ByteArray)

/**
 * Makes the thumbnail (at most [MAX_EDGE] pixels on the long side) of a PNG, JPEG or GIF (S4.8). The decoder reads a
 * subsampled image, so memory follows the size of the thumbnail, not of the original; the pixel cap is checked by the
 * caller from the header BEFORE this runs. The result is encoded anew: whatever metadata the source carried is gone.
 * (The JDK has no WebP decoder: a WebP image has its size read from the header and no thumbnail.)
 */
internal object ImageThumbnails {

    const val MAX_EDGE = 512

    /**
     * The thumbnail of the image in [channel] (closed afterwards), read through the channel in pieces - the original never
     * sits in the heap whole. Null when the image cannot be decoded (CMYK JPEG, damaged data): the file is still stored,
     * without a thumbnail.
     */
    fun create(channel: SeekableByteChannel, mediaType: String): Thumbnail? = ChannelImageInputStream(channel).use { create(it, mediaType) }

    /** The same for bytes that are in memory anyway. */
    fun create(data: ByteArray, mediaType: String): Thumbnail? =
        ImageIO.createImageInputStream(ByteArrayInputStream(data)).use { create(it, mediaType) }

    fun create(input: ImageInputStream, mediaType: String): Thumbnail? = try {
        decode(input, mediaType)?.let { encode(scaled(it), keepAlpha = mediaType != "image/jpeg" && it.colorModel.hasAlpha()) }
    } catch (_: java.io.IOException) {
        null
    } catch (_: RuntimeException) {
        null
    }

    /** The image read with subsampling, so the decoded image is about 1024 pixels at most whatever the original is. */
    private fun decode(input: ImageInputStream, mediaType: String): BufferedImage? {
        val reader = ImageIO.getImageReadersByMIMEType(mediaType).asSequence().firstOrNull() ?: return null
        try {
            reader.setInput(input, true, true)
            val step = max(1, max(reader.getWidth(0), reader.getHeight(0)) / (MAX_EDGE * 2))
            return reader.read(0, reader.defaultReadParam.apply { setSourceSubsampling(step, step, 0, 0) })
        } finally {
            reader.dispose()
        }
    }

    private fun scaled(source: BufferedImage): BufferedImage {
        val factor = MAX_EDGE.toDouble() / max(source.width, source.height)
        val alpha = source.colorModel.hasAlpha()
        val type = if (alpha) BufferedImage.TYPE_INT_ARGB else BufferedImage.TYPE_INT_RGB
        val width = if (factor < 1) max(1, (source.width * factor).toInt()) else source.width
        val height = if (factor < 1) max(1, (source.height * factor).toInt()) else source.height
        val target = BufferedImage(width, height, type)
        val graphics = target.createGraphics()
        try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY)
            graphics.drawImage(source, 0, 0, width, height, null)
        } finally {
            graphics.dispose()
        }
        return target
    }

    private fun encode(image: BufferedImage, keepAlpha: Boolean): Thumbnail? =
        if (keepAlpha) encodePng(image) else encodeJpeg(image)

    private fun encodePng(image: BufferedImage): Thumbnail? {
        val out = ByteArrayOutputStream()
        return if (ImageIO.write(image, "png", out)) Thumbnail("image/png", out.toByteArray()) else null
    }

    private fun encodeJpeg(image: BufferedImage): Thumbnail? {
        val writer = ImageIO.getImageWritersByFormatName("jpeg").asSequence().firstOrNull() ?: return null
        val out = ByteArrayOutputStream()
        try {
            ImageIO.createImageOutputStream(out).use { stream ->
                writer.output = stream
                val parameters = writer.defaultWriteParam.apply {
                    compressionMode = ImageWriteParam.MODE_EXPLICIT
                    compressionQuality = JPEG_QUALITY
                }
                writer.write(null, IIOImage(image, null, null), parameters) // no metadata object: nothing is carried over
            }
        } finally {
            writer.dispose()
        }
        return Thumbnail("image/jpeg", out.toByteArray())
    }

    private const val JPEG_QUALITY = 0.85f
}
