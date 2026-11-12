package at.dergeorg.drawboard

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

/**
 * Lives in the ROOT package of the application, not in ...core: component scan, Spring Data repository scan and
 * @ConfigurationPropertiesScan start here and therefore find every module on the runtime classpath - including
 * the generated EnumConverterConfiguration of the contract (at.dergeorg.drawboard.contract).
 */
@SpringBootApplication
@ConfigurationPropertiesScan
class DrawboardApplication

fun main(args: Array<String>) {
    runApplication<DrawboardApplication>(*args)
}
