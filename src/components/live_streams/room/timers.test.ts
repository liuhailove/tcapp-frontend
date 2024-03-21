import {describe, it} from "vitest";
import CriticalTimers from "./timers";
import {sleep} from "./utils";

describe("setInterval", () => {
    it('run once setInterval', async () => {
        CriticalTimers.setInterval(() => {
            console.info("setInterval test")
        }, 1000);
        sleep(2000);
    });
});