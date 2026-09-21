// Dump pointer-sized entries and resolve their symbols/functions.
// @category Qianniu

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.mem.MemoryAccessException;
import ghidra.program.model.symbol.Symbol;

public class QnDumpPointers extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 2) {
            printerr("Pass a start address and entry count.");
            return;
        }

        Address start = toAddr(arguments[0]);
        int count = Integer.parseInt(arguments[1]);
        for (int index = 0; index < count && !monitor.isCancelled(); ++index) {
            Address slot = start.add(index * 8L);
            try {
                Address target = toAddr(getLong(slot));
                Symbol symbol = getSymbolAt(target);
                Function function = getFunctionAt(target);
                if (function == null) {
                    function = getFunctionContaining(target);
                }
                String symbolName = symbol == null ? "<no-symbol>" : symbol.getName(true);
                String functionName = function == null
                    ? "<no-function>"
                    : function.getName(true) + " @ " + function.getEntryPoint();
                println(String.format("+0x%03x %s -> %s  %s  %s",
                    index * 8, slot, target, symbolName, functionName));
            }
            catch (MemoryAccessException exception) {
                println(String.format("+0x%03x %s <unreadable>", index * 8, slot));
            }
        }
    }
}
