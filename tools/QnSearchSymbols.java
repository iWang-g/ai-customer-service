// Search symbols and RTTI-related data for selected native type names.
// @category Qianniu

import java.util.LinkedHashSet;
import java.util.Set;

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;

public class QnSearchSymbols extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] terms = getScriptArgs();
        if (terms.length == 0) {
            printerr("Pass one or more case-sensitive search terms.");
            return;
        }

        Set<Address> printed = new LinkedHashSet<>();
        SymbolIterator symbols = currentProgram.getSymbolTable().getAllSymbols(true);
        while (symbols.hasNext() && !monitor.isCancelled()) {
            Symbol symbol = symbols.next();
            String name = symbol.getName(true);
            if (!matches(name, terms)) {
                continue;
            }
            Address address = symbol.getAddress();
            println("\nSYMBOL " + name + " @ " + address + " type=" + symbol.getSymbolType());
            printReferences(address);
            printPointers(address, 80);
            printed.add(address);
        }

        DataIterator data = currentProgram.getListing().getDefinedData(true);
        while (data.hasNext() && !monitor.isCancelled()) {
            Data item = data.next();
            StringDataInstance value = StringDataInstance.getStringDataInstance(item);
            if (value == null || value.getStringValue() == null ||
                !matches(value.getStringValue(), terms) || printed.contains(item.getAddress())) {
                continue;
            }
            println("\nSTRING " + value.getStringValue() + " @ " + item.getAddress());
            printReferences(item.getAddress());
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

    private void printReferences(Address address) {
        ReferenceIterator references = currentProgram.getReferenceManager().getReferencesTo(address);
        while (references.hasNext()) {
            Reference reference = references.next();
            Function caller = getFunctionContaining(reference.getFromAddress());
            println("  XREF " + reference.getReferenceType() + " from=" + reference.getFromAddress() +
                " function=" + (caller == null ? "<none>" : caller.getName() + "@" + caller.getEntryPoint()));
        }
    }

    private void printPointers(Address address, int count) {
        Memory memory = currentProgram.getMemory();
        for (int index = 0; index < count; index++) {
            Address slot = address.add(index * 8L);
            try {
                long raw = memory.getLong(slot);
                Address target = toAddr(raw);
                Function function = getFunctionAt(target);
                Symbol symbol = getSymbolAt(target);
                println("  PTR +0x" + Integer.toHexString(index * 8) + " " + target + " " +
                    (function != null ? function.getName() : symbol != null ? symbol.getName(true) : ""));
            }
            catch (Exception ignored) {
                return;
            }
        }
    }
}
