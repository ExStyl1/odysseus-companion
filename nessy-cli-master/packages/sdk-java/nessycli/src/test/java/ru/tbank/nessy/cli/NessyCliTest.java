package ru.tbank.nessy.cli;

import java.util.List;

import ru.tbank.nessy.cli.transport.TransportOptions;

import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static org.junit.jupiter.api.Assertions.*;

class NessyCLITest {

    private static final Logger log = LoggerFactory.getLogger(NessyCLITest.class);
    @Test
    void simpleQuery() {
        List<String> result = NessyCLI.simpleQuery("hello world");
        log.info("simpleQuery result: {}", result);
        assertNotNull(result);
    }

    @Test
    void simpleQueryWithModel() {
        List<String> result = NessyCLI.simpleQuery("hello world", new TransportOptions().setModel("qwen-plus"));
        log.info("simpleQueryWithModel result: {}", result);
        assertNotNull(result);
    }
}
