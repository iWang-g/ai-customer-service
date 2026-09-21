// List string references and direct calls made by selected functions.
// @category Qianniu

import java.util.LinkedHashSet;
import java.util.Set;

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.Symbol;

public class QnFunctionRefs extends GhidraScript {
    @Override
    public void run() throws Exception {
        for (String rawAddress : getScriptArgs()) {
            Address address = toAddr(rawAddress);
            Function function = getFunctionContaining(address);
            if (function == null) {
                println("FUNCTION " + address + " <not found>");
                continue;
            }

            println("\nFUNCTION " + function.getName() + " @ " + function.getEntryPoint());
            Set<String> strings = new LinkedHashSet<>();
            Set<String> calls = new LinkedHashSet<>();
            Set<String> symbols = new LinkedHashSet<>();
            InstructionIterator instructions = currentProgram.getListing()
                .getInstructions(function.getBody(), true);
            while (instructions.hasNext() && !monitor.isCancelled()) {
                Instruction instruction = instructions.next();
                for (Reference reference : instruction.getReferencesFrom()) {
                    Address target = reference.getToAddress();
                    if (reference.getReferenceType().isCall()) {
                        Function called = getFunctionAt(target);
                        calls.add(instruction.getAddress() + " -> " + target + " " +
                            (called == null ? "<unnamed>" : called.getName()));
                    }

                    Data data = currentProgram.getListing().getDataAt(target);
                    StringDataInstance stringData = data == null
                        ? null
                        : StringDataInstance.getStringDataInstance(data);
                    if (stringData != null && stringData.getStringValue() != null) {
                        strings.add(instruction.getAddress() + " -> " + target + " " +
                            stringData.getStringValue());
                    }

                    Symbol symbol = getSymbolAt(target);
                    if (symbol != null && !reference.getReferenceType().isCall()) {
                        String name = symbol.getName(true);
                        if (name.contains("AIM") || name.contains("function_state")) {
                            symbols.add(instruction.getAddress() + " -> " + target + " " + name);
                        }
                    }
                }
            }

            println("STRINGS");
            for (String value : strings) {
                println("  " + value);
            }
            println("SYMBOLS");
            for (String value : symbols) {
                println("  " + value);
            }
            println("CALLS");
            for (String value : calls) {
                println("  " + value);
            }
        }
    }
}
