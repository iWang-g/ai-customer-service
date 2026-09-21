// Print compact symbol and function matches for selected native names.
// @category Qianniu

import java.util.LinkedHashSet;
import java.util.Set;

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;

public class QnFindNamedAddresses extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] terms = getScriptArgs();
        if (terms.length == 0) {
            printerr("Pass one or more case-sensitive search terms.");
            return;
        }

        Set<String> printed = new LinkedHashSet<>();
        FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
        while (functions.hasNext() && !monitor.isCancelled()) {
            Function function = functions.next();
            String name = function.getName(true);
            if (matches(name, terms)) {
                String line = "FUNCTION " + function.getEntryPoint() + " " + name;
                if (printed.add(line)) {
                    println(line);
                }
            }
        }

        SymbolIterator symbols = currentProgram.getSymbolTable().getAllSymbols(true);
        while (symbols.hasNext() && !monitor.isCancelled()) {
            Symbol symbol = symbols.next();
            String name = symbol.getName(true);
            if (!matches(name, terms)) {
                continue;
            }
            Address address = symbol.getAddress();
            if (!currentProgram.getMemory().contains(address)) {
                continue;
            }
            String line = "SYMBOL " + address + " " + symbol.getSymbolType() + " " + name;
            if (printed.add(line)) {
                println(line);
            }
        }
    }

    private boolean matches(String value, String[] terms) {
        for (String term : terms) {
            if (value.contains(term)) {
                return true;
            }
        }
        return false;
    }
}
