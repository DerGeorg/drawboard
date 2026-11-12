package at.dergeorg.drawboard.api

import org.springframework.boot.autoconfigure.SpringBootApplication

/**
 * :api has no application class (that lives in :core). Web slice tests (@WebFluxTest) search upwards from their
 * package for a @SpringBootConfiguration and find this one.
 */
@SpringBootApplication
class ApiTestApplication
