// Print compact references to exact addresses or exact string values.
// Prefix addresses with addr: and strings with str:.
// @category Qianniu

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;

public class QnCompactRefs extends GhidraScript {
    @Override
    public void run() throws Exception {
        for (String argument : getScriptArgs()) {
            if (argument.startsWith("addr:")) {
                Address address = toAddr(argument.substring(5));
                println("TARGET " + address);
                printReferences(address);
            }
            else if (argument.startsWith("str:")) {
                printStringReferences(argument.substring(4));
            }
            else {
                printerr("Unknown argument: " + argument);
            }
        }
    }

    private void printStringReferences(String target) {
        DataIterator data = currentProgram.getListing().getDefinedData(true);
        while (data.hasNext() && !monitor.isCancelled()) {
            Data item = data.next();
            StringDataInstance value = StringDataInstance.getStringDataInstance(item);
            if (value == null || !target.equals(value.getStringValue())) {
                continue;
            }
            println("STRING " + item.getAddress() + " " + target);
            printReferences(item.getAddress());
        }
    }

    private void printReferences(Address address) {
        ReferenceIterator references = currentProgram.getReferenceManager().getReferencesTo(address);
        while (references.hasNext()) {
            Reference reference = references.next();
            Function function = getFunctionContaining(reference.getFromAddress());
            println("  XREF " + reference.getReferenceType() + " " + reference.getFromAddress() + " " +
                (function == null ? "<none>" : function.getName(true) + " @ " + function.getEntryPoint()));
        }
    }
}
